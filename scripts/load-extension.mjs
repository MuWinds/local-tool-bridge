#!/usr/bin/env node
/**
 * Loads the unpacked extension into an already-running Chrome, via CDP.
 *
 * ## Why this is necessary
 *
 * Chrome 137+ ignores `--load-extension` from the command line; passing it is
 * silently a no-op, which looks exactly like an extension that failed to build.
 * The supported replacement is the `Extensions` CDP domain, which requires the
 * browser to have been started with `--enable-unsafe-extension-debugging`.
 *
 * See "加载扩展到测试用 Chrome" in the README for the full workflow.
 *
 * This talks to the *browser* endpoint (not a page endpoint), because
 * `Extensions.loadUnpacked` is a browser-level command.
 *
 * Usage: node scripts/load-extension.mjs [path-to-dist]
 */

import { resolve } from "node:path";

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const extensionPath = resolve(process.argv[2] ?? "apps/extension/dist");

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browserSocket = version.webSocketDebuggerUrl;
if (!browserSocket) {
  console.error("no browser websocket URL; is Chrome running with --remote-debugging-port?");
  process.exit(1);
}

const socket = new WebSocket(browserSocket);
const pending = new Map();
let nextId = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

await new Promise((resolve) => socket.addEventListener("open", resolve));

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });

try {
  const result = await send("Extensions.loadUnpacked", { path: extensionPath });
  console.log(`loaded unpacked extension: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`Extensions.loadUnpacked failed: ${error.message}`);
  console.error(
    "\nChrome must be started with --enable-unsafe-extension-debugging for this to work.",
  );
  process.exitCode = 1;
} finally {
  socket.close();
}
