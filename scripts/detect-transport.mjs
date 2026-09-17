#!/usr/bin/env node
/**
 * Determines which browser API DeepSeek uses to send the completion request.
 *
 * This is the question that decides whether a `fetch`-only hook can work at all.
 * Rather than infer it from a bundle (minified, and free to change), this
 * instruments both `fetch` and `XMLHttpRequest` in the page's own world and
 * reports which one actually carried the request.
 *
 * Usage: node scripts/detect-transport.mjs [seconds]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const DURATION_MS = Number(process.argv[2] ?? 90) * 1000;
const MATCH = "/api/v0/chat/completion";

async function findTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.find((t) => t.type === "page" && (t.url ?? "").includes("chat.deepseek.com")) ?? null;
}

const target = await findTarget();
if (!target) {
  console.error("no chat.deepseek.com page target found");
  process.exit(1);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id === undefined) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

await new Promise((resolve) => socket.addEventListener("open", resolve));

function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");

// Instrument both APIs in the page's own world. The counters are the evidence.
const instrumentation = `
(() => {
  if (window.__dlb_transport) return 'already installed';
  const report = { fetch: 0, xhr: 0, fetchUrls: [], xhrUrls: [], patchedFetch: false, patchedXhr: false };
  window.__dlb_transport = report;

  const innerFetch = window.fetch;
  window.fetch = function () {
    try {
      const url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
      if (url.includes('${MATCH}')) { report.fetch += 1; report.fetchUrls.push(url); }
    } catch (e) {}
    return innerFetch.apply(this, arguments);
  };
  report.patchedFetch = true;

  const innerOpen = XMLHttpRequest.prototype.open;
  const innerSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dlb_url = url;
    if (typeof url === 'string' && url.includes('${MATCH}')) {
      report.xhr += 1;
      report.xhrUrls.push(url);
    }
    return innerOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    return innerSend.apply(this, arguments);
  };
  report.patchedXhr = true;

  return 'installed';
})()
`;

const installed = await send("Runtime.evaluate", { expression: instrumentation, returnByValue: true });
console.log("instrumentation:", installed.result.value);

console.log(`\nlistening ${DURATION_MS / 1000}s — send a message in the DeepSeek tab now\n`);

await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

const result = await send("Runtime.evaluate", {
  expression: "JSON.stringify(window.__dlb_transport || null)",
  returnByValue: true,
});

console.log("=== result ===");
console.log(result.result.value);

const report = JSON.parse(result.result.value ?? "null");
if (report) {
  console.log("");
  if (report.fetch > 0) console.log(`=> the completion request went through FETCH (${report.fetch})`);
  if (report.xhr > 0) console.log(`=> the completion request went through XHR (${report.xhr})`);
  if (report.fetch === 0 && report.xhr === 0) console.log("=> no completion request observed");
}

socket.close();
