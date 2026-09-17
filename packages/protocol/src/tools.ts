/**
 * Tool descriptors, argument schemas, policy model, and result shapes.
 *
 * This file is the single source of truth for what the local host can do. The
 * Rust side mirrors these names verbatim in `crates/host/src/tools/`, and
 * `tools.list` returns descriptors derived from the same table so the injected
 * system prompt can never advertise a tool the host does not implement.
 */

import type { JsonRpcId } from "./jsonrpc.js";

/**
 * A deliberately small JSON Schema subset.
 *
 * The prompt builder renders this into prose for the model, and the Rust host
 * validates against the same shape. Keeping the subset tiny means the two
 * implementations cannot drift.
 */
export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ObjectSchema extends JsonSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
}

/** How the host treats a tool call when no narrower rule matches. */
export type PolicyEffect = "allow" | "ask" | "deny";

/**
 * A policy rule. The first matching rule wins, evaluated most-specific-first:
 * an exact `tool` match beats a `tool` prefix glob, which beats the defaults.
 */
export interface PolicyRule {
  /** Tool name or glob such as `fs.*` or `shell.exec`. */
  tool: string;
  effect: PolicyEffect;
  /** Optional extra predicate, e.g. only paths under a directory. */
  when?: PolicyPredicate;
}

export interface PolicyPredicate {
  /** Glob list applied to the resolved absolute path argument. */
  pathWithin?: readonly string[];
  /** Domain allowlist for `http.request`. */
  hostIn?: readonly string[];
  /** Reject if the command matches any of these regexes. */
  commandMatches?: readonly string[];
}

export interface ToolDescriptor {
  /** Stable, dotted identifier, e.g. `fs.read_file`. */
  name: string;
  /** One-line summary shown to the model and in the GUI. */
  summary: string;
  /** Longer guidance, injected into the system prompt. */
  description: string;
  /** Grouping used by the GUI's tool list. */
  category: "fs" | "shell" | "http" | "meta";
  inputSchema: ObjectSchema;
  /** Whether the call mutates state outside the host process. */
  mutating: boolean;
  /** Advisory default when no policy rule matches. */
  defaultEffect: PolicyEffect;
  /** Rough cost hint used to order the prompt's tool list. */
  latencyHint: "instant" | "fast" | "slow";
}

/** A single block of tool output returned to the page. */
export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContentBlock[];
  /** True when the tool ran but failed in an expected, reportable way. */
  isError: boolean;
  /** Present when output was clipped to fit transport limits. */
  truncated?: boolean;
  /** Original byte count before truncation, for the model's benefit. */
  originalBytes?: number;
  /** Wall-clock duration of the handler, in milliseconds. */
  durationMs?: number;
}

export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
  /** Correlation id minted by the extension, echoed into audit logs. */
  callId: string;
  /** Page origin the call came from, e.g. `https://chat.deepseek.com`. */
  origin: string;
  /** Conversation id, when the extension can determine it. */
  conversationId?: string;
}

export interface ApprovalChallenge {
  /** Opaque token the extension returns to `tools.approve`. */
  token: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Human-readable explanation of why approval is required. */
  reason: string;
  /** The rule that produced the `ask` verdict, when there is one. */
  matchedRule?: string;
  /** Epoch milliseconds after which the challenge is void. */
  expiresAt: number;
}

export interface ApprovalDecisionParams {
  token: string;
  approved: boolean;
  /** `once` approves this call only; `always` persists a policy rule. */
  scope?: "once" | "always";
}

export interface ToolsListResult {
  tools: ToolDescriptor[];
  /** Policy revision, so the GUI can detect out-of-band edits. */
  policyRevision: number;
}

export interface HostCapabilities {
  /** Transport channels the host is currently serving. */
  transports: Array<"websocket" | "native-messaging">;
  /** Tools the host can actually execute right now. */
  availableTools: string[];
  /** True when the host can render an approval prompt to a human. */
  interactiveApproval: boolean;
  /** True when the host persists an audit log to disk. */
  auditLog: boolean;
}

export interface HelloParams {
  protocolVersion: string;
  clientVersion: string;
  /** Extension id, used by the host to bind the native messaging allowlist. */
  clientId: string;
  transports: Array<"websocket" | "native-messaging">;
}

export interface HelloResult {
  protocolVersion: string;
  hostVersion: string;
  platform: "windows" | "macos" | "linux";
  capabilities: HostCapabilities;
  /** Echoed back so the extension can detect a stale socket from a prior run. */
  sessionId: string;
}

/** Methods the extension may invoke on the host. */
export const HostMethod = {
  Hello: "bridge.hello",
  Ping: "bridge.ping",
  ToolsList: "tools.list",
  ToolsCall: "tools.call",
  ToolsApprove: "tools.approve",
  PolicyGet: "policy.get",
  PolicySet: "policy.set",
} as const;

export type HostMethod = (typeof HostMethod)[keyof typeof HostMethod];

/** Notifications the host pushes to the extension without being asked. */
export const HostNotification = {
  /** Policy changed in the GUI; the extension should re-read the tool list. */
  PolicyChanged: "bridge.policyChanged",
  /** Host is shutting down; the extension should mark itself disconnected. */
  ShuttingDown: "bridge.shuttingDown",
  /** A tool call started, for live progress UI in the page. */
  CallStarted: "tools.callStarted",
  /** A tool call finished, for live progress UI in the page. */
  CallFinished: "tools.callFinished",
} as const;

export type HostNotification = (typeof HostNotification)[keyof typeof HostNotification];

/** Methods the host may invoke on the extension. */
export const ClientMethod = {
  /** Host asks the page to display an approval prompt. */
  RequestApproval: "client.requestApproval",
  /** Host reports a state change for the in-page indicator. */
  StatusChanged: "client.statusChanged",
} as const;

export type ClientMethod = (typeof ClientMethod)[keyof typeof ClientMethod];

/** The current bridge protocol version. Bump on any breaking wire change. */
export const PROTOCOL_VERSION = "0.1.0";

/** Correlation id used by the extension for calls it originates. */
export type CallId = JsonRpcId;
