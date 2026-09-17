/**
 * `@dlb/protocol` — the wire contract shared by the Chrome extension and the
 * local Rust host.
 *
 * Everything here is transport-agnostic. The same `JsonRpcMessage` envelope is
 * sent over a loopback WebSocket or over Chrome native messaging's
 * length-prefixed stdio frames; only `framing.ts` cares which.
 */

export * from "./jsonrpc.js";
export * from "./tools.js";
export * from "./catalog.js";
export * from "./prompt.js";
export * from "./framing.js";
export * from "./stream.js";
export * from "./scrub.js";
export * from "./present.js";
