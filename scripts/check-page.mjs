#!/usr/bin/env node
/**
 * Reloads the DeepSeek page and reports whether the bridge's content script is
 * live in it.
 *
 * The extension is loaded at browser start, but a page that was already opening
 * at that moment gets no content script: injection happens at `document_start`
 * of documents that begin *after* the extension is registered. So any check must
 * reload first, which is what this does.
 *
 * Usage: node scripts/check-page.mjs [url-substring]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);

/** Finds the page target whose URL contains `needle`. */
async function findTarget(needle) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.find((t) => t.type === "page" && (t.url ?? "").includes(needle)) ?? null;
}

/** Opens a CDP session with a promise-based `send`. */
async function connect(target) {
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

  return { socket, send };
}

const needle = process.argv[2] ?? "chat.deepseek.com";
const target = await findTarget(needle);
if (!target) {
  console.error(`no page target matching "${needle}"`);
  process.exit(1);
}

const { socket, send } = await connect(target);
await send("Page.enable");
await send("Runtime.enable");
await send("Page.reload", { ignoreCache: false });

// Let the document, the content script, and the hook run.
await new Promise((resolve) => setTimeout(resolve, 9000));

const probe = `JSON.stringify({
  url: location.href,
  scrubStyle: !!document.getElementById('__dlb_scrub_styles__'),
  styleText: (document.getElementById('__dlb_scrub_styles__') || {}).textContent || null,
  hookInstalled: typeof window.__dlbDebug,
  messages: document.querySelectorAll('.ds-message').length,
  emptyBubbles: document.querySelectorAll('.ds-message[data-dlb-empty="1"]').length,
  thinkBlocks: document.querySelectorAll('.ds-think-content').length
})`;

const result = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
const value = JSON.parse(result.result.value ?? "null");
console.log(JSON.stringify(value, null, 2));

socket.close();

if (value?.scrubStyle || value?.hookInstalled !== "undefined") {
  console.log("\nRESULT: the bridge is live in this page.");
  process.exit(0);
}
console.log("\nRESULT: no content script in this page (extension not applied).");
process.exit(1);
