/**
 * The built-in tool catalogue.
 *
 * This table is authoritative: the Rust host implements exactly these names,
 * and the prompt builder advertises exactly these names. Adding a tool means
 * adding an entry here *and* a handler in `crates/host/src/tools/`.
 *
 * Security posture, stated once so every tool inherits it:
 * - Paths are resolved and canonicalised by the host before any policy check,
 *   so `..` and symlinks cannot escape a configured root.
 * - Every mutating tool defaults to `ask`, never `allow`.
 * - Output is truncated by the host, never by the model's good manners.
 */

import type { ToolDescriptor } from "./tools.js";

export const FS_READ_FILE: ToolDescriptor = {
  name: "fs.read_file",
  summary: "Read a UTF-8 text file from disk",
  description:
    "Reads a file and returns its contents. Use `offset` and `limit` for large files. Binary files are refused rather than mangled.",
  category: "fs",
  mutating: false,
  defaultEffect: "ask",
  latencyHint: "instant",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "integer", description: "1-based first line to return", minimum: 1 },
      limit: { type: "integer", description: "Maximum number of lines", minimum: 1, maximum: 5000 },
      encoding: { type: "string", enum: ["utf-8", "utf-16le", "gbk"], default: "utf-8" },
    },
    required: ["path"],
  },
};

export const FS_WRITE_FILE: ToolDescriptor = {
  name: "fs.write_file",
  summary: "Create or overwrite a text file",
  description:
    "Writes text to a file, creating parent directories when needed. Always requires explicit human approval because it destroys existing content unless `mode` is `append`.",
  category: "fs",
  mutating: true,
  defaultEffect: "ask",
  latencyHint: "instant",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to write" },
      content: { type: "string", description: "Full file contents" },
      mode: { type: "string", enum: ["overwrite", "append", "create"], default: "overwrite" },
      createDirs: { type: "boolean", description: "Create missing parent directories", default: true },
    },
    required: ["path", "content"],
  },
};

export const FS_LIST_DIR: ToolDescriptor = {
  name: "fs.list_dir",
  summary: "List the entries of a directory",
  description:
    "Returns names, sizes, and modification times for a directory. Non-recursive by default; set `recursive` with a `glob` to walk a tree.",
  category: "fs",
  mutating: false,
  defaultEffect: "ask",
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

export const FS_SEARCH: ToolDescriptor = {
  name: "fs.search",
  summary: "Search file contents with a regular expression",
  description:
    "Recursively searches text files under a directory and returns matching lines with their line numbers. Skips binary files, `.git`, and `node_modules` by default.",
  category: "fs",
  mutating: false,
  defaultEffect: "ask",
  latencyHint: "slow",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute directory to search" },
      pattern: { type: "string", description: "Rust regex syntax" },
      glob: { type: "string", description: "Restrict to matching files, e.g. `*.rs`" },
      ignoreCase: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
      contextLines: { type: "integer", minimum: 0, maximum: 10, default: 0 },
    },
    required: ["path", "pattern"],
  },
};

export const SHELL_EXEC: ToolDescriptor = {
  name: "shell.exec",
  summary: "Run a shell command and capture its output",
  description:
    "Executes a command in the user's default shell and returns stdout, stderr, and the exit code. The host enforces a timeout and a command denylist; every invocation requires approval unless the user has allowlisted the exact command.",
  category: "shell",
  mutating: true,
  defaultEffect: "ask",
  latencyHint: "slow",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute" },
      cwd: { type: "string", description: "Absolute working directory" },
      timeoutMs: { type: "integer", minimum: 100, maximum: 600000, default: 60000 },
      stdin: { type: "string", description: "Text piped to the process's stdin" },
      env: { type: "object", description: "Extra environment variables" },
    },
    required: ["command"],
  },
};

export const HTTP_REQUEST: ToolDescriptor = {
  name: "http.request",
  summary: "Make an HTTP request to an allowlisted host",
  description:
    "Performs an HTTP request and returns status, headers, and body. Only hosts on the user's allowlist are reachable; loopback and private ranges are blocked by default to prevent the model from reaching internal services.",
  category: "http",
  mutating: true,
  defaultEffect: "ask",
  latencyHint: "slow",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: "GET" },
      headers: { type: "object", description: "Request headers" },
      body: { type: "string", description: "Request body for non-GET methods" },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
      maxBytes: { type: "integer", minimum: 1, maximum: 10485760, default: 1048576 },
    },
    required: ["url"],
  },
};

/** Every tool the host ships with, in prompt-rendering order. */
export const BUILTIN_TOOLS: readonly ToolDescriptor[] = [
  FS_READ_FILE,
  FS_LIST_DIR,
  FS_SEARCH,
  FS_WRITE_FILE,
  SHELL_EXEC,
  HTTP_REQUEST,
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
  { tool: "fs.read_file", effect: "ask" as const },
  { tool: "fs.list_dir", effect: "allow" as const },
  { tool: "fs.search", effect: "allow" as const },
  { tool: "fs.write_file", effect: "ask" as const },
  { tool: "shell.exec", effect: "ask" as const },
  { tool: "http.request", effect: "ask" as const },
];
