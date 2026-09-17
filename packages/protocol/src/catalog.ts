/**
 * The built-in tool catalogue — the Codex-compatible surface.
 *
 * This table is authoritative: the Rust host implements exactly these names,
 * and the MCP endpoint advertises exactly these names. Adding a tool means
 * adding an entry here *and* a handler in `crates/core/src/tools/codex.rs`.
 *
 * Security posture, stated once so every tool inherits it:
 * - Paths are resolved and canonicalised by the host before any policy check,
 *   so `..` and symlinks cannot escape a configured root.
 * - Every mutating tool defaults to `ask`, never `allow`.
 * - Output is truncated by the host, never by the model's good manners.
 */

import type { ToolDescriptor } from "./tools.js";

export const CODEX_READ_FILE: ToolDescriptor = {
  name: "read_file",
  summary: "Read a UTF-8 text file from disk (Codex schema)",
  description:
    "Reads a file using the bridge's existing filesystem sandbox and encoding support. By default output is prefixed with line numbers, which also normalises line endings; pass `lineNumbers: false` to get the file byte-for-byte. Binary files are refused rather than mangled.",
  category: "codex-filesystem",
  mutating: false,
  defaultEffect: "ask",
  latencyHint: "instant",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "integer", description: "1-based first line to return", minimum: 1 },
      limit: { type: "integer", description: "Maximum number of lines", minimum: 1, maximum: 5000 },
      lineNumbers: {
        type: "boolean",
        description: "Prefix each line with its number (normalises line endings)",
        default: true,
      },
      encoding: { type: "string", enum: ["utf-8", "utf-16le", "gbk"], default: "utf-8" },
    },
    required: ["path"],
  },
};

export const CODEX_LIST_DIR: ToolDescriptor = {
  name: "list_dir",
  summary: "List directory entries (Codex schema)",
  description:
    "Lists directory entries using the bridge's existing filesystem sandbox. Non-recursive by default; set `recursive` with a `glob` to walk a tree.",
  category: "codex-filesystem",
  mutating: false,
  defaultEffect: "allow",
  latencyHint: "instant",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute directory path" },
      recursive: { type: "boolean", default: false },
      glob: { type: "string", description: "Filter such as `**/*.ts`" },
      includeHidden: { type: "boolean", default: false },
      maxEntries: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
    },
    required: ["path"],
  },
};

export const CODEX_EXEC: ToolDescriptor = {
  name: "exec",
  summary: "Run a command using the configured shell",
  description:
    "Codex-compatible command execution schema. The bridge keeps shell selection under its GUI policy; the optional shell field is accepted for schema compatibility but cannot override the configured shell.",
  category: "codex-execution",
  mutating: true,
  defaultEffect: "ask",
  latencyHint: "slow",
  inputSchema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "Command line to execute" },
      shell: {
        type: "string",
        description: "Compatibility field; shell is selected by the bridge policy",
      },
      login: { type: "boolean", default: true },
      tty: { type: "boolean", default: false },
      yield_time_ms: { type: "integer", minimum: 0, maximum: 600000, default: 10000 },
      timeout_ms: { type: "integer", minimum: 100, maximum: 600000 },
      max_output_tokens: { type: "integer", minimum: 1, maximum: 100000 },
      cwd: { type: "string", description: "Absolute working directory" },
      env: { type: "object", description: "Extra environment variables" },
    },
    required: ["cmd"],
  },
};

export const CODEX_UNIFIED_EXEC: ToolDescriptor = {
  name: "unified_exec",
  summary: "Run a command through the unified exec schema",
  description:
    "Codex unified-exec compatible schema backed by the bridge's existing shell executor and policy controls.",
  category: "codex-execution",
  mutating: true,
  defaultEffect: "ask",
  latencyHint: "slow",
  inputSchema: CODEX_EXEC.inputSchema,
};

export const CODEX_APPLY_PATCH: ToolDescriptor = {
  name: "apply_patch",
  summary: "Create, update, delete, or move files with a patch",
  description:
    "Applies the Codex file-oriented patch format directly to the sandboxed filesystem. Supported operations are Add File, Delete File, Update File, and Update File with Move to.",
  category: "codex-filesystem",
  mutating: true,
  defaultEffect: "ask",
  latencyHint: "instant",
  inputSchema: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "A Codex apply_patch document beginning with *** Begin Patch and ending with *** End Patch",
      },
    },
    required: ["patch"],
  },
};

/** Every tool the host exposes to clients, in prompt-rendering order. */
export const BUILTIN_TOOLS: readonly ToolDescriptor[] = [
  CODEX_READ_FILE,
  CODEX_LIST_DIR,
  CODEX_EXEC,
  CODEX_UNIFIED_EXEC,
  CODEX_APPLY_PATCH,
];

/** Fast lookup by name. */
export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDescriptor> = new Map(
  BUILTIN_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * The policy applied on first run.
 *
 * Reading still asks, because the model can read SSH keys and `.env` files.
 * The user is expected to widen this in the GUI once they trust a directory.
 */
export const DEFAULT_POLICY_RULES = [
  { tool: "read_file", effect: "ask" as const },
  { tool: "list_dir", effect: "allow" as const },
  { tool: "exec", effect: "ask" as const },
  { tool: "unified_exec", effect: "ask" as const },
  { tool: "apply_patch", effect: "ask" as const },
];
