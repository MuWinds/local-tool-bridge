/**
 * JSON-RPC 2.0 envelopes used on every hop of the bridge.
 *
 * The exact same envelope travels over both transports (local WebSocket and
 * Chrome native messaging), so the Rust host and the extension can share a
 * single dispatcher and a single set of error semantics.
 *
 * Keep the wire shape in sync with `crates/host/src/rpc.rs`.
 */

export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;

export type JsonRpcMessage<P = unknown, R = unknown> =
  | JsonRpcRequest<P>
  | JsonRpcNotification<P>
  | JsonRpcResponse<R>;

/**
 * Standard JSON-RPC codes plus the bridge's implementation-defined range.
 *
 * -32000..-32099 is reserved by the spec for implementation-defined server
 * errors, which is exactly where the bridge-specific failures live.
 */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  /** The host process is not running or the socket is gone. */
  HostUnavailable: -32000,
  /** The shared secret in the handshake did not match. */
  NotAuthenticated: -32001,
  /** The bridge protocol versions are incompatible. */
  ProtocolMismatch: -32002,

  ToolNotFound: -32010,
  /** A policy rule refused the call outright. */
  ToolDenied: -32011,
  /** The call needs a human decision before it can run. */
  ApprovalRequired: -32012,
  /** The human never answered in time. */
  ApprovalTimeout: -32013,
  PathNotAllowed: -32014,
  HostNotAllowed: -32015,
  ToolTimeout: -32016,
  /** Result exceeded the transport or configured size cap. */
  OutputTooLarge: -32017,
  RateLimited: -32018,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

/**
 * An error that carries a JSON-RPC code all the way across the bridge.
 *
 * Anything thrown by a tool handler is converted to one of these before it is
 * serialised, so the page always receives a structured code instead of an
 * opaque string.
 */
export class BridgeError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.data = data;
  }

  toErrorObject(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  /** Wraps an arbitrary thrown value, preserving `BridgeError` instances. */
  static from(cause: unknown, fallbackCode: number = RpcErrorCode.InternalError): BridgeError {
    if (cause instanceof BridgeError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new BridgeError(fallbackCode, message || "Unknown bridge failure");
  }
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["jsonrpc"] === JSONRPC_VERSION &&
    "method" in candidate &&
    typeof candidate["method"] === "string" &&
    "id" in candidate &&
    candidate["id"] !== null
  );
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["jsonrpc"] === JSONRPC_VERSION &&
    typeof candidate["method"] === "string" &&
    !("id" in candidate)
  );
}

export function isJsonRpcFailure(value: unknown): value is JsonRpcFailure {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate["jsonrpc"] === JSONRPC_VERSION && "error" in candidate;
}

export function isJsonRpcSuccess<R = unknown>(value: unknown): value is JsonRpcSuccess<R> {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["jsonrpc"] === JSONRPC_VERSION &&
    "result" in candidate &&
    !("error" in candidate)
  );
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isJsonRpcSuccess(value) || isJsonRpcFailure(value);
}

/** Parses a transport payload into an envelope, or throws a `BridgeError`. */
export function decodeJsonRpc(raw: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new BridgeError(
      RpcErrorCode.ParseError,
      `Malformed JSON on the bridge: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BridgeError(RpcErrorCode.InvalidRequest, "Bridge payload must be a JSON object");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope["jsonrpc"] !== JSONRPC_VERSION) {
    throw new BridgeError(
      RpcErrorCode.InvalidRequest,
      `Unsupported JSON-RPC version: ${String(envelope["jsonrpc"])}`,
    );
  }
  return parsed as JsonRpcMessage;
}
