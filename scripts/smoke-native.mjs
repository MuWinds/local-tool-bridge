#!/usr/bin/env node
/**
 * End-to-end smoke test for the native messaging transport.
 *
 * This drives the real `ltb-host native` binary over the real Chrome framing
 * (4-byte little-endian length prefix + JSON), which is the only way to catch
 * bugs that unit tests on either side of the boundary cannot: a framing
 * mismatch, a stdout contaminating the wire, or a handshake that never
 * completes.
 *
 * It is deliberately dependency-free so it can run anywhere Node runs.
 *
 * Usage: node scripts/smoke-native.mjs [path-to-ltb-host]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BINARY =
  process.argv[2] ??
  resolve(
    import.meta.dirname,
    "../apps/desktop/target/debug",
    process.platform === "win32" ? "ltb-host.exe" : "ltb-host",
  );

if (!existsSync(BINARY)) {
  console.error(`Host binary not found at ${BINARY}`);
  console.error("Build it first: cargo build -p ltb-host");
  process.exit(1);
}

/** Wraps a value in Chrome's native messaging frame. */
function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder for the host's stdout stream. */
class Decoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
}

/** A policy granting access to a scratch directory, with no audit log. */
function writeTestPolicy(directory) {
  const workspace = join(directory, "workspace");
  const policy = {
    revision: 0,
    rules: [
      { tool: "fs.list_dir", effect: "allow" },
      { tool: "fs.read_file", effect: "allow" },
      { tool: "fs.search", effect: "allow" },
      { tool: "fs.write_file", effect: "allow" },
      { tool: "shell.exec", effect: "allow" },
      { tool: "http.request", effect: "allow" },
    ],
    roots: [workspace],
    allowedHosts: ["example.com"],
    allowPrivateNetwork: false,
    defaultTimeoutMs: 20000,
    maxOutputChars: 20000,
  };
  const policyPath = join(directory, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  return { policyPath, workspace };
}

const scratch = mkdtempSync(join(tmpdir(), "dlb-smoke-"));
const { policyPath, workspace } = writeTestPolicy(scratch);
// The fixtures must live *inside* the sandbox root; the policy grants access to
// `workspace`, not to `scratch`.
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "hello.txt"), "line one\nline two\nline three\n");
// A file the denylist must refuse, even inside an allowed root.
writeFileSync(join(workspace, "server.pem"), "-----BEGIN PRIVATE KEY-----");

const child = spawn(BINARY, ["--policy", policyPath, "--no-audit", "native"], {
  stdio: ["pipe", "pipe", "pipe"],
});

const decoder = new Decoder();
const pending = new Map();
let stdoutBytes = 0;
let nextId = 1;

child.stdout.on("data", (chunk) => {
  stdoutBytes += chunk.length;
  for (const message of decoder.push(chunk)) {
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

// stderr is where all diagnostics go; surface it so a failure is diagnosable.
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[host] ${chunk}`);
});

/** Sends a request and resolves with the reply. */
function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Timed out waiting for ${method}`));
    }, 15000);

    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  });
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  const mark = condition ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${name}${detail && !condition ? ` — ${detail}` : ""}`);
}

try {
  // 1. Handshake. Native messaging needs no shared secret: Chrome only launches
  //    a host binary named in the extension's manifest, so the OS-level launch
  //    is the authentication. The WebSocket transport does require one.
  const hello = await request("bridge.hello", {
    protocolVersion: "0.1.0",
    clientVersion: "smoke",
    clientId: "test",
    transports: ["native-messaging"],
  });
  check("handshake succeeds without a shared secret", hello.result !== undefined, JSON.stringify(hello.error));
  check("host reports a platform", typeof hello.result?.platform === "string");
  check(
    "host advertises all six builtin tools",
    hello.result?.capabilities?.availableTools?.length === 6,
    JSON.stringify(hello.result?.capabilities?.availableTools),
  );

  // 2. Tool catalogue.
  const list = await request("tools.list", {});
  check("tools.list returns descriptors", list.result?.tools?.length === 6);
  check(
    "every descriptor carries an input schema",
    list.result?.tools?.every((tool) => tool.inputSchema?.type === "object"),
  );

  // 3. A real filesystem read.
  const read = await request("tools.call", {
    name: "fs.read_file",
    arguments: { path: join(workspace, "hello.txt") },
    callId: "smoke-read",
    origin: "https://chat.deepseek.com",
  });
  const readText = read.result?.content?.[0]?.text ?? "";
  check("fs.read_file returns the file body", readText.includes("line two"));
  check("fs.read_file reports success", read.result?.isError === false);

  // 4. A real directory listing.
  const listing = await request("tools.call", {
    name: "fs.list_dir",
    arguments: { path: workspace },
    callId: "smoke-list",
    origin: "https://chat.deepseek.com",
  });
  check("fs.list_dir returns entries", (listing.result?.content?.[0]?.text ?? "").includes("hello.txt"));

  // 5. Argument validation must reject an unknown argument.
  const badArg = await request("tools.call", {
    name: "fs.list_dir",
    arguments: { path: workspace, nonsense: true },
    callId: "smoke-bad-arg",
    origin: "https://chat.deepseek.com",
  });
  check("unknown arguments are rejected", badArg.error !== undefined, JSON.stringify(badArg.result));

  // 6. Path confinement must reject an escape attempt.
  const escape = await request("tools.call", {
    name: "fs.read_file",
    arguments: { path: join(scratch, "policy.json") },
    callId: "smoke-escape",
    origin: "https://chat.deepseek.com",
  });
  check(
    "a path outside the sandbox root is refused",
    escape.error?.code === -32014,
    JSON.stringify(escape.error ?? escape.result),
  );

  // 7. The denylist must refuse a private key even inside an allowed root.
  const denied = await request("tools.call", {
    name: "fs.read_file",
    arguments: { path: join(workspace, "server.pem") },
    callId: "smoke-denylist",
    origin: "https://chat.deepseek.com",
  });
  check(
    "the denylist refuses .pem files inside an allowed root",
    denied.error?.code === -32014,
    JSON.stringify(denied.error ?? denied.result),
  );

  // 8. A real shell command.
  const shell = await request("tools.call", {
    name: "shell.exec",
    arguments: { command: "echo bridge-ok", cwd: workspace },
    callId: "smoke-shell",
    origin: "https://chat.deepseek.com",
  });
  check("shell.exec captures stdout", (shell.result?.content?.[0]?.text ?? "").includes("bridge-ok"));

  // 9. The destructive-command denylist must outrank the allow rule.
  const destructive = await request("tools.call", {
    name: "shell.exec",
    arguments: { command: "rm -rf /" },
    callId: "smoke-destructive",
    origin: "https://chat.deepseek.com",
  });
  check(
    "the destructive denylist refuses `rm -rf /` despite an allow rule",
    destructive.error?.code === -32011,
    JSON.stringify(destructive.error ?? destructive.result),
  );

  // 10. The HTTP host allowlist must refuse a host that is not listed.
  const http = await request("tools.call", {
    name: "http.request",
    arguments: { url: "https://not-allowlisted.example.org/" },
    callId: "smoke-http",
    origin: "https://chat.deepseek.com",
  });
  check(
    "an unlisted host is refused",
    http.error?.code === -32015,
    JSON.stringify(http.error ?? http.result),
  );

  // 11. An unknown method must produce a JSON-RPC method-not-found.
  const unknown = await request("does.not.exist", {});
  check("an unknown method returns -32601", unknown.error?.code === -32601);
} catch (error) {
  check("smoke run completed without throwing", false, String(error));
} finally {
  child.stdin.end();
  child.kill();
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailures:");
  for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
}
console.log(`stdout bytes received: ${stdoutBytes}`);
process.exit(failed.length === 0 ? 0 : 1);
