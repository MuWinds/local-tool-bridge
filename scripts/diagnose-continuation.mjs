#!/usr/bin/env node
/**
 * Records a timeline of every completion request and its response.
 *
 * This exists to answer one question: is the proof-of-work header reusable?
 *
 * The continuation request is built by replaying the headers captured from the
 * page's own request, including `x-ds-pow-response`. If the server treats a
 * challenge as single-use, the replayed request is rejected with
 * `INVALID_POW_RESPONSE` while the original succeeds — and the two entries will
 * carry an identical PoW value, which is the smoking gun.
 *
 * Usage: node scripts/diagnose-continuation.mjs [seconds]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const DURATION_MS = Number(process.argv[2] ?? 80) * 1000;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && (t.url ?? "").includes("chat.deepseek.com"));
if (!target) {
  console.error("no chat page");
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

const instrument = `
(() => {
  window.__dlb_timeline = [];
  const open = XMLHttpRequest.prototype.open;
  const sendFn = XMLHttpRequest.prototype.send;
  const setHdr = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = String(u);
    this.__pow = null;
    this.__parent = null;
    return open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const lower = String(name).toLowerCase();
    if (lower === 'x-ds-pow-response') this.__pow = String(value).slice(0, 60);
    return setHdr.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__u && this.__u.includes('/api/v0/chat/completion')) {
      const entry = {
        n: window.__dlb_timeline.length + 1,
        t: Math.round(performance.now()),
        pow: this.__pow,
        bodyLen: body ? String(body).length : 0,
        hasContract: body ? String(body).includes('工具名就是标签名') : false,
        hasToolResult: body ? String(body).includes('<tool_result') : false,
        promptHead: null,
        status: null,
        responseHead: null,
      };
      try {
        const parsed = JSON.parse(String(body));
        entry.promptHead = String(parsed.prompt || '').slice(0, 70);
        entry.parentMessageId = parsed.parent_message_id;
      } catch (e) {}

      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4) {
          entry.status = this.status;
          try { entry.responseHead = String(this.responseText || '').slice(0, 160); } catch (e) { entry.responseHead = '<unreadable>'; }
        }
      });

      window.__dlb_timeline.push(entry);
    }
    return sendFn.apply(this, arguments);
  };

  return 'installed';
})()
`;

console.log("instrumentation:", (await send("Runtime.evaluate", { expression: instrument, returnByValue: true })).result.value);
console.log(`\nlistening ${DURATION_MS / 1000}s — send a message that needs a tool now\n`);

await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

const result = await send("Runtime.evaluate", {
  expression: "JSON.stringify(window.__dlb_timeline || [])",
  returnByValue: true,
});

const timeline = JSON.parse(result.result.value || "[]");

console.log("=== completion request timeline ===");
for (const entry of timeline) {
  console.log(`\n#${entry.n}  t=+${entry.t}ms  status=${entry.status}`);
  console.log(`   pow        : ${entry.pow ? entry.pow.slice(0, 44) + "..." : "(none captured)"}`);
  console.log(`   bodyLen    : ${entry.bodyLen}`);
  console.log(`   contract   : ${entry.hasContract}`);
  console.log(`   toolResult : ${entry.hasToolResult}`);
  console.log(`   parentId   : ${entry.parentMessageId}`);
  console.log(`   promptHead : ${JSON.stringify(entry.promptHead)}`);
  console.log(`   response   : ${JSON.stringify(entry.responseHead)}`);
}

console.log("\n=== analysis ===");
if (timeline.length >= 2) {
  const pows = timeline.map((e) => e.pow);
  const allSame = pows.every((p) => p === pows[0]);
  console.log(`requests: ${timeline.length}`);
  console.log(`all PoW values identical: ${allSame}`);
  const failures = timeline.filter((e) => (e.responseHead || "").includes("INVALID_POW"));
  console.log(`requests rejected for INVALID_POW: ${failures.length} (entries ${failures.map((f) => "#" + f.n).join(", ") || "none"})`);
  if (allSame && failures.length > 0) {
    console.log("\n=> CONFIRMED: the PoW header is single-use; replaying it is rejected.");
  }
} else {
  console.log(`only ${timeline.length} completion request(s) observed`);
}

socket.close();
