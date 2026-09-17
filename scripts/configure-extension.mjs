#!/usr/bin/env node
/**
 * Configures the loaded extension: enables it and installs the bridge secret.
 *
 * The popup normally does this by hand. Driving it from CDP instead means an
 * end-to-end run needs no clicking, and — more importantly — it can be repeated.
 *
 * Talks to the extension's *service worker* target, which is where
 * `chrome.storage.local` lives for this extension.
 *
 * Usage: node scripts/configure-extension.mjs <secret> [port]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const secret = process.argv[2];
const websocketPort = Number(process.argv[3] ?? 8788);

if (!secret) {
  console.error("usage: configure-extension.mjs <secret> [port]");
  process.exit(2);
}

/** Finds the extension's service worker or background page target. */
async function findExtensionTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return (
    targets.find((t) => (t.url ?? "").startsWith("chrome-extension://")) ??
    targets.find((t) => t.type === "service_worker") ??
    null
  );
}

const target = await findExtensionTarget();
if (!target) {
  console.error("no extension target found; is the extension loaded?");
  process.exit(1);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
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

const expression = `
  (async () => {
    await chrome.storage.local.set({
      settings: {
        enabled: true,
        transport: "http",
        websocketPort: ${websocketPort},
        secret: ${JSON.stringify(secret)},
        nativeToolsMode: false,
        locale: "zh",
        showIndicator: true,
        disabledTools: []
      }
    });
    const stored = await chrome.storage.local.get("settings");
    return JSON.stringify(stored.settings);
  })()
`;

const result = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});

if (result.exceptionDetails) {
  console.error(`evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  process.exit(1);
}

console.log(`extension configured: ${result.result.value}`);
socket.close();
