/**
 * `@dlb/protocol` — the wire contract shared between clients and the local
 * Rust host.
 *
 * Everything here is transport-agnostic. The same `JsonRpcMessage` envelope is
 * sent over a loopback WebSocket or an HTTP request; only `jsonrpc.ts` cares
 * about the wire shape.
 */

export * from "./jsonrpc.js";
export * from "./tools.js";
export * from "./catalog.js";
