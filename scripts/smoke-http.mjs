#!/usr/bin/env node
/**
 * End-to-end smoke test for the loopback HTTP transport.
 *
 * Exercises the real `ltb-host serve` binary over real HTTP, covering the
 * health probe, secret enforcement, origin rejection, and a genuine tool call.
 *
 * Usage: node scripts/smoke-http.mjs [port]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.argv[2] ?? 8899);
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

const scratch = mkdtempSync(join(tmpdir(), "dlb-http-"));
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
        { tool: "list_dir", effect: "allow" },
        { tool: "read_file", effect: "allow" },
        { tool: "exec", effect: "allow" },
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

const child = spawn(BINARY, ["--policy", policyPath, "--no-audit", "--port", String(PORT), "serve"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

/** Everything the host printed to stdout, accumulated as it arrives. */
let stdout = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

/** Waits until the host prints its listening line. */
function waitForReady(timeoutMs = 15000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs;

    const poll = () => {
      if (stdout.includes("listening on")) {
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

/** Reads the secret the host printed at startup. */
function readSecret() {
  const match = /bridge secret: ([0-9a-f]+)/.exec(stdout);
  return match ? match[1] : null;
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail && !condition ? ` — ${detail}` : ""}`);
}

/** Issues one JSON-RPC call over HTTP. */
async function rpc(method, params, { secret, origin } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(secret ? { "x-dlb-secret": secret } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

try {
  await waitForReady();
  const secret = readSecret();
  check("host exposes its bridge secret", typeof secret === "string" && secret.length > 0);

  // 1. The unauthenticated health probe.
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  const healthBody = await health.json();
  check("GET /health answers without a secret", health.status === 200 && healthBody.status === "ok");

  // 2. A call without the secret must be refused.
  const unauthenticated = await rpc("tools.list", {});
  check(
    "a request without the secret is rejected",
    unauthenticated.status === 401 && unauthenticated.body.error?.code === -32001,
    JSON.stringify(unauthenticated.body),
  );

  // 3. A call from a hostile origin must be refused.
  const hostile = await rpc("tools.list", {}, { secret, origin: "https://evil.example.com" });
  check("a request from a disallowed origin is rejected", hostile.status === 403);

  // 4. The handshake works over HTTP. Like the WebSocket transport, `hello` is
  //    the one method whose secret travels inside its params rather than in a
  //    header, so it is exempt from the header check and validated by the
  //    dispatcher instead.
  const hello = await rpc("bridge.hello", {
    protocolVersion: "0.1.0",
    clientVersion: "smoke",
    clientId: "test",
    transports: ["http"],
    secret,
  });
  check("handshake succeeds", hello.body.result !== undefined, JSON.stringify(hello.body.error));

  // 5. A handshake with the wrong secret must still be refused.
  const badHello = await rpc("bridge.hello", {
    protocolVersion: "0.1.0",
    clientVersion: "smoke",
    clientId: "test",
    transports: ["http"],
    secret: "not-the-secret",
  });
  check(
    "a handshake with the wrong secret is refused",
    badHello.body.error?.code === -32001,
    JSON.stringify(badHello.body),
  );

  // 6. A protocol version mismatch is reported distinctly, so the user is told
  //    to update rather than being shown a confusing auth error.
  const mismatched = await rpc("bridge.hello", {
    protocolVersion: "99.0.0",
    clientVersion: "smoke",
    clientId: "test",
    transports: ["http"],
    secret,
  });
  check(
    "a protocol major mismatch is reported as such",
    mismatched.body.error?.code === -32002,
    JSON.stringify(mismatched.body),
  );

  // 6. An authenticated tool listing.
  const list = await rpc("tools.list", {}, { secret });
  check("tools.list returns descriptors", list.body.result?.tools?.length === 5);

  // 7. A real tool call over HTTP.
  const read = await rpc(
    "tools.call",
    {
      name: "read_file",
      arguments: { path: join(workspace, "note.txt") },
      callId: "http-1",
      origin: "local-test",
    },
    { secret },
  );
  check(
    "read_file returns the file body",
    (read.body.result?.content?.[0]?.text ?? "").includes("beta"),
    JSON.stringify(read.body),
  );

  // 8. Path confinement still applies over this transport.
  const escape = await rpc(
    "tools.call",
    {
      name: "read_file",
      arguments: { path: policyPath },
      callId: "http-2",
      origin: "local-test",
    },
    { secret },
  );
  check("path confinement applies over HTTP", escape.body.error?.code === -32014);

  // 9. An unknown path 404s rather than silently succeeding.
  const missing = await fetch(`http://127.0.0.1:${PORT}/nope`, { method: "POST", body: "{}" });
  check("an unknown path returns 404", missing.status === 404);

  // 10. A CORS preflight is answered.
  const preflight = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "OPTIONS",
    headers: { origin: "https://local.test" },
  });
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
