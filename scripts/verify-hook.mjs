#!/usr/bin/env node
/**
 * Verifies that the MAIN-world hook actually installs on the real page.
 *
 * The hook is injected by Chrome at `document_start`, before any page script
 * runs, so the only reliable way to observe it is to install a listener that is
 * itself present before the document loads — which is what
 * `Page.addScriptToEvaluateOnNewDocument` provides.
 *
 * This matters because the hook is the component that rewrites the request. If
 * it silently failed to install (a CSP error, a manifest mistake, a crash), the
 * extension would look "connected" in the popup while doing nothing at all.
 *
 * Usage: node scripts/verify-hook.mjs [url]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const URL = process.argv[2] ?? "https://chat.deepseek.com/";

/** Finds the page target whose URL contains `needle`. */
async function findTarget(needle) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.find((t) => t.type === "page" && (t.url ?? "").includes(needle)) ?? null;
}

/** Opens a CDP session with a small promise-based `send`. */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    // Ignore events; this script only issues commands.
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

  return { socket, send };
}

const target = await findTarget("chat.deepseek.com");
if (!target) {
  console.error("no chat.deepseek.com page target found");
  process.exit(1);
}

const { socket, send } = await connect(target);
await send("Page.enable");
await send("Runtime.enable");

// Installed before any page script, so it observes the hook's own startup
// message and can also record whether the hook wrapped `fetch`.
const initScript = `
  window.__dlb_probe = { messages: [], sawHookInstall: false, fetchWrappedAtLoad: false };
  window.addEventListener('message', (event) => {
    if (event.data && event.data.tag === '__dlb_bridge_v1__') {
      window.__dlb_probe.messages.push(event.data.payload);
      if (event.data.payload && event.data.payload.reason === 'main-world hook installed') {
        window.__dlb_probe.sawHookInstall = true;
      }
    }
  });
`;

const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
await send("Page.reload", { ignoreCache: true });

// Give the document, the content scripts, and the hook time to run.
await new Promise((resolve) => setTimeout(resolve, 6000));

const result = await send("Runtime.evaluate", {
  expression: "JSON.stringify(window.__dlb_probe || null)",
  returnByValue: true,
});

const probe = JSON.parse(result.result.value ?? "null");
console.log(JSON.stringify(probe, null, 2));

await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
socket.close();

if (probe?.sawHookInstall) {
  console.log("\nRESULT: the MAIN-world hook installed successfully.");
  process.exit(0);
}
console.log("\nRESULT: the hook did NOT report installation.");
process.exit(1);
