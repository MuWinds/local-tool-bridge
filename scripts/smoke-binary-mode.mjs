#!/usr/bin/env node
/**
 * Byte-exactness regression test for the native messaging transport.
 *
 * On Windows, a stdio channel left in the C runtime's *text* mode rewrites every
 * `\n` as `\r\n`. That silently corrupts the 4-byte length prefix, because the
 * declared byte count no longer matches what actually arrives — and once a frame
 * boundary slips, every subsequent message is garbage. The failure is total and
 * permanent, so it is worth a dedicated test rather than a comment.
 *
 * This drives the real host binary with payloads full of newlines, CRLFs, and
 * multi-byte UTF-8, and asserts the content survives byte-for-byte.
 *
 * Usage: node scripts/smoke-binary-mode.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/** Wraps a value in Chrome's native messaging frame. */
function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder that also verifies every declared length. */
class Decoder {
  #buffer = Buffer.alloc(0);
  /** Bytes received, for the total-integrity check. */
  received = 0;

  push(chunk) {
    this.received += chunk.length;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    const messages = [];
    while (this.#buffer.length >= 4) {
      const declared = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + declared) break;

      const body = this.#buffer.subarray(4, 4 + declared);
      this.#buffer = this.#buffer.subarray(4 + declared);

      // A text-mode channel would inflate the body, so the declared length and
      // the actual payload would disagree here.
      const text = body.toString("utf8");
      messages.push(JSON.parse(text));
    }
    return messages;
  }

  /** Bytes left over that never formed a complete frame. */
  get leftover() {
    return this.#buffer.length;
  }
}

const scratch = mkdtempSync(join(tmpdir(), "dlb-binmode-"));
const workspace = join(scratch, "workspace");
mkdirSync(workspace, { recursive: true });

// Payloads chosen to expose any newline translation.
const CASES = [
  { name: "LF newlines", content: "line one\nline two\nline three\n" },
  { name: "CRLF newlines", content: "dos one\r\ndos two\r\n" },
  { name: "mixed line endings", content: "a\nb\r\nc\rd\n" },
  { name: "no trailing newline", content: "no trailing newline here" },
  { name: "multi-byte UTF-8", content: "中文内容\n第二行\n日本語\nemoji 🎉\n" },
  { name: "JSON metacharacters", content: '{"key": "value"}\n\\backslash\\\n"quoted"\n' },
  { name: "many newlines", content: "\n".repeat(500) },
  { name: "large multi-line body", content: ("payload line with some length\n").repeat(2000) },
];

const policyPath = join(scratch, "policy.json");
writeFileSync(
  policyPath,
  JSON.stringify(
    {
      revision: 0,
      rules: [{ tool: "fs.read_file", effect: "allow" }],
      roots: [workspace],
      allowedHosts: [],
      allowPrivateNetwork: false,
      defaultTimeoutMs: 20000,
      maxOutputChars: 1_000_000,
    },
    null,
    2,
  ),
);

const child = spawn(BINARY, ["--policy", policyPath, "--no-audit", "native"], {
  stdio: ["pipe", "pipe", "pipe"],
});

const decoder = new Decoder();
const pending = new Map();
let nextId = 1;
let stderr = "";

child.stdout.on("data", (chunk) => {
  for (const message of decoder.push(chunk)) {
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`timed out on ${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

/** Extracts the numbered file body from an `fs.read_file` reply. */
function numberedBodyOf(reply) {
  const text = reply.result?.content?.[0]?.text ?? "";
  // `fs.read_file` prefixes a header and numbers each line; the raw content is
  // reconstructed by stripping both so the comparison is precise.
  const lines = text.split("\n");
  return lines
    .slice(1)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab === -1 ? line : line.slice(tab + 1);
    })
    .join("\n");
}

/** The raw body of a `lineNumbers: false` reply. */
function rawBodyOf(reply) {
  return reply.result?.content?.[0]?.text ?? "";
}

try {
  await request("bridge.hello", {
    protocolVersion: "0.1.0",
    clientVersion: "binmode",
    clientId: "test",
    transports: ["native-messaging"],
  });

  for (const testCase of CASES) {
    const path = join(workspace, `${testCase.name.replace(/\W+/g, "-")}.txt`);
    // Written with an explicit encoding so Node does not normalise anything.
    writeFileSync(path, Buffer.from(testCase.content, "utf8"));

    const reply = await request("tools.call", {
      name: "fs.read_file",
      arguments: { path, limit: 5000 },
      callId: `binmode-${testCase.name}`,
      origin: "local-test",
    });

    if (reply.error) {
      check(testCase.name, false, JSON.stringify(reply.error));
      continue;
    }

    // The decisive assertion for frame integrity: the full character sequence
    // survived the round trip through the framed stdio channel.
    const expected = readFileSync(path, "utf8");
    const returned = numberedBodyOf(reply);

    // The numbered view emits exactly one `\n` per source line, so it cannot
    // reproduce CRLF or a missing final newline. Compare on that basis: split
    // both into lines, drop the trailing empty element each produces, and strip
    // the `\r` the view discards.
    const asLines = (text) => {
      const parts = text.split("\n").map((line) => line.replace(/\r$/, ""));
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      return parts;
    };

    const expectedLines = asLines(expected);
    const returnedLines = asLines(returned);

    check(
      `${testCase.name} (numbered view)`,
      JSON.stringify(returnedLines) === JSON.stringify(expectedLines),
      `expected ${expectedLines.length} lines, got ${returnedLines.length}`,
    );
  }

  // Byte-exact round trip. This is the mode a model should use when it intends
  // to write the content back, because the numbered view cannot represent CRLF
  // or a missing trailing newline.
  for (const testCase of CASES) {
    const path = join(workspace, `${testCase.name.replace(/\W+/g, "-")}.txt`);

    const reply = await request("tools.call", {
      name: "fs.read_file",
      arguments: { path, limit: 5000, lineNumbers: false },
      callId: `binmode-raw-${testCase.name}`,
      origin: "local-test",
    });

    if (reply.error) {
      check(`${testCase.name} (raw)`, false, JSON.stringify(reply.error));
      continue;
    }

    const returned = rawBodyOf(reply);
    const expected = readFileSync(path, "utf8");
    check(
      `${testCase.name} (raw, byte-exact)`,
      returned === expected,
      `expected ${expected.length} chars, got ${returned.length}; ` +
        `expected ${JSON.stringify(expected.slice(0, 40))}, got ${JSON.stringify(returned.slice(0, 40))}`,
    );
  }

  // A desynchronised frame boundary would leave unparseable bytes behind.
  check("no leftover bytes in the frame buffer", decoder.leftover === 0, `${decoder.leftover} bytes`);
} catch (error) {
  check("run completed without throwing", false, String(error));
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
  if (stderr) console.log(`\nhost stderr:\n${stderr}`);
}
process.exit(failed.length === 0 ? 0 : 1);
