#!/usr/bin/env node
/**
 * End-to-end smoke test for the MCP (Model Context Protocol) transport.
 *
 * Exercises the real `ltb-host serve-mcp` binary over real HTTP, covering the
 * lifecycle ChatGPT/Codex and OpenAI's Secure MCP Tunnel depend on: secret
 * enforcement, the initialize handshake, session tracking, tool discovery,
 * real tool calls, and the failure shapes a model must be able to read.
 *
 * Usage: node scripts/smoke-mcp.mjs [port]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.argv[2] ?? 8910);
const BINARY = resolve(
  import.meta.dirname,
  "../apps/desktop/target/debug",
  process.platform === "win32" ? "ltb-host.exe" : "ltb-host",
);

if (!existsSync(BINARY)) {
  console.error(`Host binary not found at ${BINARY}`);
  console.error("Build it first: cargo build -p ltb-host");
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "dlb-mcp-"));
const workspace = join(scratch, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "note.txt"), "alpha\nbeta\n");

const policyPath = join(scratch, "policy.json");
writeFileSync(
  policyPath,
  JSON.stringify(
    {
      revision: 0,
      rules: [
        { tool: "fs.list_dir", effect: "allow" },
        { tool: "fs.read_file", effect: "allow" },
        { tool: "shell.exec", effect: "allow" },
      ],
      roots: [workspace],
      allowedHosts: [],
      allowPrivateNetwork: false,
      defaultTimeoutMs: 20000,
      maxOutputChars: 20000,
    },
    null,
    2,
  ),
);

const child = spawn(
  BINARY,
  ["--policy", policyPath, "--no-audit", "--mcp-port", String(PORT), "serve-mcp"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

let stdout = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

function waitForReady(timeoutMs = 15000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (stdout.includes("MCP listening on")) {
        resolvePromise();
        return;
      }
      if (Date.now() > deadline) {
        rejectPromise(new Error(`host did not start in ${timeoutMs}ms\n${stderr}`));
        return;
      }
      setTimeout(poll, 50);
    };
    child.on("exit", (code) => {
      rejectPromise(new Error(`host exited early with code ${code}\n${stderr}`));
    });
    poll();
  });
}

function readSecret() {
  const match = /bridge secret: ([0-9a-f]+)/.exec(stdout);
  return match ? match[1] : null;
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail && !condition ? ` — ${detail}` : ""}`);
}

const MCP = `http://127.0.0.1:${PORT}/mcp`;

/** Issues one MCP JSON-RPC request. */
async function mcp(method, params, { secret, sessionId, id = 1 } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-dlb-secret"] = secret;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), body };
}

/** Sends a notification (no id) and returns only the HTTP status. */
async function notify(method, params, { secret, sessionId } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-dlb-secret"] = secret;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  return response.status;
}

let sessionId = null;

try {
  await waitForReady();
  const secret = readSecret();
  check("host exposes its bridge secret", typeof secret === "string" && secret.length > 0);

  // 1. The unauthenticated health probe.
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  const healthBody = await health.json();
  check("GET /health answers without a secret", health.status === 200 && healthBody.status === "ok");

  // 2. Every MCP request, including initialize, is gated by the secret.
  const unauthenticated = await mcp("initialize", { protocolVersion: "2026-07-28" });
  check(
    "initialize without the secret is rejected",
    unauthenticated.status === 401 && unauthenticated.body.error?.code === -32001,
    JSON.stringify(unauthenticated.body),
  );

  // 3. The handshake creates a session and advertises tool capabilities.
  const init = await mcp("initialize", { protocolVersion: "2026-07-28" }, { secret });
  sessionId = init.sessionId;
  check("initialize returns a session id header", typeof sessionId === "string" && sessionId.length > 0);
  check(
    "initialize negotiates the protocol version",
    init.body.result?.protocolVersion === "2026-07-28",
    JSON.stringify(init.body),
  );
  check(
    "initialize advertises tools",
    init.body.result?.capabilities?.tools !== undefined,
    JSON.stringify(init.body),
  );
  check("server identifies itself", init.body.result?.serverInfo?.name === "local-tool-bridge");

  // 4. The initialized notification is acknowledged without a JSON-RPC reply.
  const ack = await notify("notifications/initialized", {}, { secret, sessionId });
  check("notifications/initialized is acknowledged with 202", ack === 202);

  // 5. Tool discovery returns every bridge tool under an MCP-safe name.
  const list = await mcp("tools/list", {}, { secret, sessionId });
  const tools = list.body.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  check("tools/list returns six tools", tools.length === 6, JSON.stringify(list.body));
  check("tool names are MCP-safe (no dots)", names.includes("fs_read_file") && names.every((n) => !n.includes(".")));
  check("every tool declares an object schema", tools.every((tool) => tool.inputSchema?.type === "object"));

  // 6. A real read-only tool call.
  const dir = await mcp(
    "tools/call",
    { name: "fs_list_dir", arguments: { path: workspace } },
    { secret, sessionId },
  );
  check(
    "fs_list_dir returns the workspace listing",
    (dir.body.result?.content?.[0]?.text ?? "").includes("note.txt") && dir.body.result?.isError === false,
    JSON.stringify(dir.body),
  );

  // 7. File content round-trips.
  const read = await mcp(
    "tools/call",
    { name: "fs_read_file", arguments: { path: join(workspace, "note.txt") } },
    { secret, sessionId },
  );
  check(
    "fs_read_file returns the file body",
    (read.body.result?.content?.[0]?.text ?? "").includes("beta"),
    JSON.stringify(read.body),
  );

  // 8. An unknown tool is a protocol error, not a tool result. Strict clients
  //    (the official Go SDK) require the error response to echo the request
  //    id — a null id decodes as "invalid request" and kills the connection.
  const unknown = await mcp("tools/call", { name: "definitely_not_a_tool" }, { secret, sessionId, id: 42 });
  check("an unknown tool returns -32602", unknown.body.error?.code === -32602, JSON.stringify(unknown.body));
  check(
    "error responses echo the request id",
    unknown.body.id === 42 && unknown.body.error !== undefined,
    JSON.stringify(unknown.body),
  );

  // 9. The stateless 2026-07-28 discovery handshake modern clients send first.
  //    OpenAI's connector validates this response shape; missing resultType /
  //    capabilities / serverInfo is rejected as "response was invalid".
  const discover = await mcp("server/discover", {}, { secret, id: 7 });
  check(
    "server/discover advertises the modern protocol version",
    Array.isArray(discover.body.result?.supportedVersions) &&
      discover.body.result.supportedVersions.includes("2026-07-28"),
    JSON.stringify(discover.body),
  );
  check(
    "server/discover is a complete result with capabilities",
    discover.body.result?.resultType === "complete" &&
      discover.body.result?.capabilities?.tools !== undefined,
    JSON.stringify(discover.body),
  );
  check(
    "server/discover identifies the server",
    discover.body.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "local-tool-bridge",
    JSON.stringify(discover.body),
  );
  check("server/discover echoes the request id", discover.body.id === 7, JSON.stringify(discover.body));

  // 10. Every non-initialize complete result carries resultType: "complete".
  check(
    "tools/list is a complete result",
    list.body.result?.resultType === "complete",
    JSON.stringify(list.body),
  );

  // 9. A sandbox escape is surfaced as an isError tool result so the model
  //    sees the refusal and adapts.
  const escape = await mcp(
    "tools/call",
    { name: "fs_read_file", arguments: { path: policyPath } },
    { secret, sessionId },
  );
  check(
    "a sandbox escape becomes an isError result",
    escape.body.result?.isError === true && escape.body.error === undefined,
    JSON.stringify(escape.body),
  );

  // 10. Requests without a session are served statelessly (newer MCP clients).
  const stateless = await mcp("tools/list", {}, { secret });
  check("tools/list works without a session id", (stateless.body.result?.tools ?? []).length === 6);

  // 11. A stale session id is reported, not silently served.
  const stale = await mcp("tools/list", {}, { secret, sessionId: "tunnel_does_not_exist" });
  check("an unknown session id returns -32001", stale.body.error?.code === -32001, JSON.stringify(stale.body));

  // 12. ping is answered.
  const ping = await mcp("ping", {}, { secret, sessionId });
  check("ping is answered", ping.body.result !== undefined && ping.body.error === undefined);

  // 13. Session termination.
  const deleted = await fetch(MCP, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId, "x-dlb-secret": secret },
  });
  check("DELETE /mcp terminates the session", deleted.status === 200);
  const afterDelete = await mcp("tools/list", {}, { secret, sessionId });
  check("the terminated session is refused afterwards", afterDelete.body.error?.code === -32001);

  // 14. The transport-level surface: GET streaming is not supported.
  const get = await fetch(MCP, { headers: { "x-dlb-secret": secret } });
  check("GET /mcp returns 405", get.status === 405);

  // 15. CORS preflight is answered for browser-based test clients.
  const preflight = await fetch(MCP, { method: "OPTIONS" });
  check("an OPTIONS preflight is answered", preflight.status === 204);
} catch (error) {
  check("smoke run completed without throwing", false, String(error));
} finally {
  child.kill();
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailures:");
  for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);
