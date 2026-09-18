//! Minimal single-user OAuth 2.1-style authorization server for Direct MCP.
//!
//! This is intentionally small: it supports one pre-registered confidential
//! client, Authorization Code + PKCE (S256), refresh tokens, RFC 8414-style
//! authorization-server metadata, and MCP protected-resource metadata. Tokens
//! are opaque-to-the-client signed capabilities so they survive host restarts
//! without a token database.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use rand::RngCore;
use ring::{digest, hmac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::{Url, form_urlencoded};

const AUTH_PATH: &str = "/oauth/authorize";
const TOKEN_PATH: &str = "/oauth/token";
const AS_METADATA_PATH: &str = "/.well-known/oauth-authorization-server";
const RESOURCE_METADATA_PATH: &str = "/.well-known/oauth-protected-resource";
const MAX_FORM_BYTES: usize = 64 * 1024;
const AUTH_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);
const AUTH_CODE_TTL: Duration = Duration::from_secs(5 * 60);
const ACCESS_TOKEN_TTL: Duration = Duration::from_secs(60 * 60);
const REFRESH_TOKEN_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone)]
pub struct OAuthServerConfig {
    pub public_base_url: String,
    pub resource_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub signing_key: Vec<u8>,
}

#[derive(Debug, Clone)]
struct PendingAuthorization {
    client_id: String,
    redirect_uri: String,
    state: Option<String>,
    code_challenge: String,
    scope: String,
    expires_at: u64,
}

#[derive(Debug, Clone)]
struct AuthorizationCode {
    client_id: String,
    redirect_uri: String,
    code_challenge: String,
    scope: String,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenClaims {
    version: u8,
    kind: String,
    client_id: String,
    resource: String,
    scope: String,
    exp: u64,
    nonce: String,
}

pub struct OAuthServer {
    base_url: String,
    resource_url: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    signing_key: Vec<u8>,
    pending: Mutex<HashMap<String, PendingAuthorization>>,
    codes: Mutex<HashMap<String, AuthorizationCode>>,
}

impl OAuthServer {
    pub fn new(config: OAuthServerConfig) -> Result<Self, String> {
        let mut base = Url::parse(config.public_base_url.trim())
            .map_err(|error| format!("invalid OAuth public base URL: {error}"))?;
        if base.query().is_some() || base.fragment().is_some() {
            return Err("OAuth public base URL must not contain a query or fragment".into());
        }
        let path = base.path().trim_end_matches('/').to_string();
        base.set_path(&path);
        let base_url = base.as_str().trim_end_matches('/').to_string();

        let redirect = Url::parse(config.redirect_uri.trim())
            .map_err(|error| format!("invalid OAuth redirect URI: {error}"))?;
        if redirect.scheme() != "https" {
            return Err("OAuth redirect URI must use https".into());
        }
        if config.client_id.trim().is_empty() || config.client_secret.trim().is_empty() {
            return Err("OAuth client ID and secret must not be empty".into());
        }
        if config.signing_key.len() < 32 {
            return Err("OAuth signing key must contain at least 32 bytes".into());
        }

        Ok(Self {
            base_url,
            resource_url: config.resource_url,
            client_id: config.client_id,
            client_secret: config.client_secret,
            redirect_uri: redirect.to_string(),
            signing_key: config.signing_key,
            pending: Mutex::new(HashMap::new()),
            codes: Mutex::new(HashMap::new()),
        })
    }

    pub fn handles_path(&self, path: &str) -> bool {
        matches!(
            path,
            AUTH_PATH | TOKEN_PATH | AS_METADATA_PATH | RESOURCE_METADATA_PATH
        )
    }

    pub fn resource_metadata_url(&self) -> String {
        format!("{}{}", self.base_url, RESOURCE_METADATA_PATH)
    }

    pub fn validate_access_token(&self, token: &str) -> bool {
        self.verify_token(token, "access").is_some()
    }

    pub async fn handle(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        match (request.method().clone(), request.uri().path()) {
            (Method::GET, AS_METADATA_PATH) => self.authorization_server_metadata(),
            (Method::GET, RESOURCE_METADATA_PATH) => self.protected_resource_metadata(),
            (Method::GET, AUTH_PATH) => self.authorization_page(request),
            (Method::POST, AUTH_PATH) => self.authorization_decision(request).await,
            (Method::POST, TOKEN_PATH) => self.token(request).await,
            _ => text_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"),
        }
    }

    fn authorization_server_metadata(&self) -> Response<Full<Bytes>> {
        json_response(
            StatusCode::OK,
            json!({
                "issuer": self.base_url,
                "authorization_endpoint": format!("{}{}", self.base_url, AUTH_PATH),
                "token_endpoint": format!("{}{}", self.base_url, TOKEN_PATH),
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": ["mcp", "offline_access"],
                "token_endpoint_auth_methods_supported": [
                    "client_secret_basic",
                    "client_secret_post"
                ]
            }),
        )
    }

    fn protected_resource_metadata(&self) -> Response<Full<Bytes>> {
        json_response(
            StatusCode::OK,
            json!({
                "resource": self.resource_url,
                "authorization_servers": [self.base_url],
                "scopes_supported": ["mcp", "offline_access"],
                "bearer_methods_supported": ["header"]
            }),
        )
    }

    fn authorization_page(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let params = query_params(request.uri().query().unwrap_or_default());

        let response_type = params.get("response_type").map(String::as_str);
        let client_id = params.get("client_id").map(String::as_str);
        let redirect_uri = params.get("redirect_uri").map(String::as_str);
        let code_challenge = params.get("code_challenge").map(String::as_str);
        let code_challenge_method = params.get("code_challenge_method").map(String::as_str);

        if response_type != Some("code") {
            return oauth_error_page("unsupported_response_type", "response_type must be code");
        }
        if client_id != Some(self.client_id.as_str()) {
            return oauth_error_page("unauthorized_client", "unknown client_id");
        }
        if redirect_uri != Some(self.redirect_uri.as_str()) {
            return oauth_error_page(
                "invalid_request",
                "redirect_uri does not match the registered client",
            );
        }
        if code_challenge_method != Some("S256") {
            return oauth_error_page("invalid_request", "PKCE code_challenge_method must be S256");
        }
        let Some(code_challenge) = code_challenge else {
            return oauth_error_page("invalid_request", "missing PKCE code_challenge");
        };
        if code_challenge.len() < 32 || code_challenge.len() > 128 {
            return oauth_error_page("invalid_request", "invalid PKCE code_challenge length");
        }

        let scope = match normalize_scope(params.get("scope").map(String::as_str)) {
            Ok(scope) => scope,
            Err(message) => return oauth_error_page("invalid_scope", &message),
        };

        if let Some(resource) = params.get("resource") {
            if resource != &self.resource_url {
                return oauth_error_page(
                    "invalid_target",
                    "resource does not match this MCP server",
                );
            }
        }

        self.prune_expired();
        let request_id = random_token(24);
        self.pending
            .lock()
            .expect("OAuth pending lock poisoned")
            .insert(
                request_id.clone(),
                PendingAuthorization {
                    client_id: self.client_id.clone(),
                    redirect_uri: self.redirect_uri.clone(),
                    state: params.get("state").cloned(),
                    code_challenge: code_challenge.to_string(),
                    scope: scope.clone(),
                    expires_at: unix_now() + AUTH_REQUEST_TTL.as_secs(),
                },
            );

        let body = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Local Tool Bridge OAuth</title>\
             <style>body{{font-family:system-ui;max-width:680px;margin:64px auto;padding:0 20px;background:#161616;color:#eee}}\
             .card{{border:1px solid #444;border-radius:14px;padding:24px;background:#202020}}\
             code{{word-break:break-all}}button{{padding:10px 18px;margin-right:8px;border-radius:8px;border:0}}\
             .allow{{background:#2b8a5a;color:white}}.deny{{background:#555;color:white}}</style></head>\
             <body><div class=\"card\"><h1>Local Tool Bridge</h1><p>ChatGPT 请求连接此 MCP。</p>\
             <p><b>Client</b><br><code>{}</code></p><p><b>Scope</b><br><code>{}</code></p>\
             <p><b>Redirect</b><br><code>{}</code></p>\
             <form method=\"post\" action=\"{}\"><input type=\"hidden\" name=\"request_id\" value=\"{}\">\
             <button class=\"allow\" name=\"decision\" value=\"allow\">允许</button>\
             <button class=\"deny\" name=\"decision\" value=\"deny\">拒绝</button></form></div></body></html>",
            html_escape(&self.client_id),
            html_escape(&scope),
            html_escape(&self.redirect_uri),
            AUTH_PATH,
            request_id,
        );
        html_response(StatusCode::OK, body)
    }

    async fn authorization_decision(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let params = match read_form(request).await {
            Ok(params) => params,
            Err(response) => return response,
        };
        let Some(request_id) = params.get("request_id") else {
            return oauth_error_page("invalid_request", "missing request_id");
        };
        let Some(pending) = self
            .pending
            .lock()
            .expect("OAuth pending lock poisoned")
            .remove(request_id)
        else {
            return oauth_error_page(
                "invalid_request",
                "authorization request expired or unknown",
            );
        };
        if pending.expires_at < unix_now() {
            return oauth_error_page("invalid_request", "authorization request expired");
        }

        if params.get("decision").map(String::as_str) != Some("allow") {
            return redirect_oauth_error(
                &pending.redirect_uri,
                pending.state.as_deref(),
                "access_denied",
            );
        }

        let code = random_token(32);
        self.codes.lock().expect("OAuth code lock poisoned").insert(
            code.clone(),
            AuthorizationCode {
                client_id: pending.client_id,
                redirect_uri: pending.redirect_uri.clone(),
                code_challenge: pending.code_challenge,
                scope: pending.scope,
                expires_at: unix_now() + AUTH_CODE_TTL.as_secs(),
            },
        );

        let mut redirect = match Url::parse(&pending.redirect_uri) {
            Ok(url) => url,
            Err(_) => {
                return oauth_error_page("server_error", "registered redirect URI is invalid");
            }
        };
        {
            let mut query = redirect.query_pairs_mut();
            query.append_pair("code", &code);
            if let Some(state) = pending.state {
                query.append_pair("state", &state);
            }
        }
        redirect_response(redirect.as_str())
    }

    async fn token(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        let headers = request.headers().clone();
        let params = match read_form(request).await {
            Ok(params) => params,
            Err(response) => return response,
        };

        if !self.authenticate_client(&headers, &params) {
            return oauth_json_error(StatusCode::UNAUTHORIZED, "invalid_client");
        }

        match params.get("grant_type").map(String::as_str) {
            Some("authorization_code") => self.exchange_authorization_code(&params),
            Some("refresh_token") => self.exchange_refresh_token(&params),
            _ => oauth_json_error(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
        }
    }

    fn authenticate_client(
        &self,
        headers: &hyper::HeaderMap,
        params: &HashMap<String, String>,
    ) -> bool {
        if let Some(value) = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
        {
            if let Some((scheme, encoded)) = value.split_once(' ') {
                if scheme.eq_ignore_ascii_case("basic") {
                    if let Ok(bytes) = STANDARD.decode(encoded) {
                        if let Ok(credentials) = String::from_utf8(bytes) {
                            if let Some((id, secret)) = credentials.split_once(':') {
                                return secure_eq(id, &self.client_id)
                                    && secure_eq(secret, &self.client_secret);
                            }
                        }
                    }
                }
            }
        }

        let id = params
            .get("client_id")
            .map(String::as_str)
            .unwrap_or_default();
        let secret = params
            .get("client_secret")
            .map(String::as_str)
            .unwrap_or_default();
        secure_eq(id, &self.client_id) && secure_eq(secret, &self.client_secret)
    }

    fn exchange_authorization_code(
        &self,
        params: &HashMap<String, String>,
    ) -> Response<Full<Bytes>> {
        let Some(code) = params.get("code") else {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        };
        let Some(record) = self
            .codes
            .lock()
            .expect("OAuth code lock poisoned")
            .remove(code)
        else {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        };

        if record.expires_at < unix_now()
            || params
                .get("client_id")
                .is_some_and(|id| id != &record.client_id)
            || params.get("redirect_uri").map(String::as_str) != Some(record.redirect_uri.as_str())
        {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        }

        let Some(verifier) = params.get("code_verifier") else {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        };
        if pkce_s256(verifier) != record.code_challenge {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        }

        self.token_response(&record.scope)
    }

    fn exchange_refresh_token(&self, params: &HashMap<String, String>) -> Response<Full<Bytes>> {
        let Some(token) = params.get("refresh_token") else {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        };
        let Some(claims) = self.verify_token(token, "refresh") else {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        };
        if !claims
            .scope
            .split_whitespace()
            .any(|scope| scope == "offline_access")
        {
            return oauth_json_error(StatusCode::BAD_REQUEST, "invalid_grant");
        }
        self.token_response(&claims.scope)
    }

    fn token_response(&self, scope: &str) -> Response<Full<Bytes>> {
        let access_token = self.issue_token("access", ACCESS_TOKEN_TTL, scope);
        let mut value = json!({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_TTL.as_secs(),
            "scope": scope,
        });
        if scope
            .split_whitespace()
            .any(|item| item == "offline_access")
        {
            value["refresh_token"] =
                serde_json::Value::String(self.issue_token("refresh", REFRESH_TOKEN_TTL, scope));
        }
        json_response(StatusCode::OK, value)
    }

    fn issue_token(&self, kind: &str, ttl: Duration, scope: &str) -> String {
        let claims = TokenClaims {
            version: 1,
            kind: kind.to_string(),
            client_id: self.client_id.clone(),
            resource: self.resource_url.clone(),
            scope: scope.to_string(),
            exp: unix_now() + ttl.as_secs(),
            nonce: random_token(16),
        };
        let payload = serde_json::to_vec(&claims).expect("OAuth token claims must serialize");
        let payload = URL_SAFE_NO_PAD.encode(payload);
        let key = hmac::Key::new(hmac::HMAC_SHA256, &self.signing_key);
        let signature = hmac::sign(&key, payload.as_bytes());
        format!(
            "ltb1.{}.{}",
            payload,
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }

    fn verify_token(&self, token: &str, expected_kind: &str) -> Option<TokenClaims> {
        let mut parts = token.split('.');
        if parts.next()? != "ltb1" {
            return None;
        }
        let payload = parts.next()?;
        let signature = parts.next()?;
        if parts.next().is_some() {
            return None;
        }

        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        let key = hmac::Key::new(hmac::HMAC_SHA256, &self.signing_key);
        hmac::verify(&key, payload.as_bytes(), &signature).ok()?;

        let claims: TokenClaims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
        if claims.version != 1
            || claims.kind != expected_kind
            || claims.client_id != self.client_id
            || claims.resource != self.resource_url
            || claims.exp < unix_now()
            || !claims.scope.split_whitespace().any(|scope| scope == "mcp")
        {
            return None;
        }
        Some(claims)
    }

    fn prune_expired(&self) {
        let now = unix_now();
        self.pending
            .lock()
            .expect("OAuth pending lock poisoned")
            .retain(|_, request| request.expires_at >= now);
        self.codes
            .lock()
            .expect("OAuth code lock poisoned")
            .retain(|_, code| code.expires_at >= now);
    }
}

fn normalize_scope(raw: Option<&str>) -> Result<String, String> {
    let raw = raw.unwrap_or("mcp");
    let mut scopes = Vec::new();
    for scope in raw.split_whitespace() {
        if !matches!(scope, "mcp" | "offline_access") {
            return Err(format!("unsupported scope: {scope}"));
        }
        if !scopes.iter().any(|known| known == &scope) {
            scopes.push(scope);
        }
    }
    if !scopes.contains(&"mcp") {
        scopes.insert(0, "mcp");
    }
    Ok(scopes.join(" "))
}

fn pkce_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()).as_ref())
}

fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn secure_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn query_params(query: &str) -> HashMap<String, String> {
    form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

async fn read_form(
    request: Request<Incoming>,
) -> Result<HashMap<String, String>, Response<Full<Bytes>>> {
    let body = request
        .into_body()
        .collect()
        .await
        .map_err(|_| oauth_json_error(StatusCode::BAD_REQUEST, "invalid_request"))?
        .to_bytes();
    if body.len() > MAX_FORM_BYTES {
        return Err(oauth_json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
        ));
    }
    Ok(form_urlencoded::parse(&body).into_owned().collect())
}

fn redirect_oauth_error(
    redirect_uri: &str,
    state: Option<&str>,
    error: &str,
) -> Response<Full<Bytes>> {
    let Ok(mut url) = Url::parse(redirect_uri) else {
        return oauth_error_page("server_error", "registered redirect URI is invalid");
    };
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("error", error);
        if let Some(state) = state {
            query.append_pair("state", state);
        }
    }
    redirect_response(url.as_str())
}

fn redirect_response(location: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header("location", location)
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::new()))
        .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "redirect failed"))
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .body(Full::new(Bytes::from(value.to_string())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from("{}"))))
}

fn oauth_json_error(status: StatusCode, error: &str) -> Response<Full<Bytes>> {
    json_response(status, json!({ "error": error }))
}

fn html_response(status: StatusCode, body: String) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        )
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

fn text_response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn oauth_error_page(error: &str, description: &str) -> Response<Full<Bytes>> {
    html_response(
        StatusCode::BAD_REQUEST,
        format!(
            "<!doctype html><meta charset=\"utf-8\"><title>OAuth error</title>\
             <body style=\"font-family:system-ui;max-width:700px;margin:64px auto\">\
             <h1>OAuth error</h1><p><code>{}</code></p><p>{}</p></body>",
            html_escape(error),
            html_escape(description)
        ),
    )
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> OAuthServer {
        OAuthServer::new(OAuthServerConfig {
            public_base_url: "https://example.com:8443".into(),
            resource_url: "https://example.com:8443/mcp".into(),
            client_id: "client".into(),
            client_secret: "secret".into(),
            redirect_uri: "https://chatgpt.com/connector/oauth/callback".into(),
            signing_key: vec![7; 32],
        })
        .unwrap()
    }

    #[test]
    fn pkce_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_s256(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn signed_access_tokens_survive_stateless_validation() {
        let server = server();
        let token = server.issue_token("access", Duration::from_secs(60), "mcp offline_access");
        assert!(server.validate_access_token(&token));
        assert!(!server.validate_access_token(&(token + "x")));
    }

    #[test]
    fn refresh_token_is_not_an_access_token() {
        let server = server();
        let token = server.issue_token("refresh", Duration::from_secs(60), "mcp offline_access");
        assert!(!server.validate_access_token(&token));
        assert!(server.verify_token(&token, "refresh").is_some());
    }

    #[test]
    fn scope_is_restricted_to_mcp_and_offline_access() {
        assert_eq!(
            normalize_scope(Some("offline_access")).unwrap(),
            "mcp offline_access"
        );
        assert!(normalize_scope(Some("mcp admin")).is_err());
    }
}
