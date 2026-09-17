#!/usr/bin/env node
/**
 * Captures the raw completion response stream and replays it through the real
 * decoder.
 *
 * The decoder was written against a documented stream shape, but the only thing
 * that settles whether it matches reality is the actual bytes. This grabs them
 * from the live page and runs them through `DeepSeekStreamDecoder` offline, so a
 * mismatch shows up as "the parser found nothing" rather than as a vague
 * "the tool did not run".
 *
 * Usage: node scripts/capture-stream.mjs [seconds]
 */

import { DeepSeekStreamDecoder, AnswerAccumulator, ToolCallStreamParser } from "../packages/protocol/dist/index.js";

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const DURATION_MS = Number(process.argv[2] ?? 75) * 1000;

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

// Capture the raw response text of the next completion XHR, plus a marker for
// how the page itself is reading it.
const instrument = `
(() => {
  window.__dlb_stream = { chunks: [], full: null, responseType: null, done: false, error: null };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = String(u);
    return open.apply(this, arguments);
  };
  const sendFn = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__u && this.__u.includes('/api/v0/chat/completion')) {
      const rec = window.__dlb_stream;
      this.addEventListener('readystatechange', () => {
        try {
          rec.responseType = this.responseType;
          if (this.readyState >= 3) {
            const t = this.responseText;
            rec.full = t;
            rec.chunks.push(t.length);
          }
          if (this.readyState === 4) rec.done = true;
        } catch (e) { rec.error = String(e && e.message); }
      });
    }
    return sendFn.apply(this, arguments);
  };
  return 'installed';
})()
`;

const installed = await send("Runtime.evaluate", { expression: instrument, returnByValue: true });
console.log("instrumentation:", installed.result.value);
console.log(`\nlistening ${DURATION_MS / 1000}s — send a message now\n`);

await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

const result = await send("Runtime.evaluate", {
  expression: "JSON.stringify({ done: window.__dlb_stream.done, len: (window.__dlb_stream.full||'').length, responseType: window.__dlb_stream.responseType, error: window.__dlb_stream.error, chunkCount: window.__dlb_stream.chunks.length, head: (window.__dlb_stream.full||'').slice(0, 400), tail: (window.__dlb_stream.full||'').slice(-300) })",
  returnByValue: true,
});

const captured = JSON.parse(result.result.value);
console.log("=== capture ===");
console.log("responseType:", JSON.stringify(captured.responseType));
console.log("total length:", captured.len);
console.log("readystatechange ticks:", captured.chunkCount);
console.log("error:", captured.error);
console.log("head:", JSON.stringify(captured.head));
console.log("tail:", JSON.stringify(captured.tail));

// Now replay through the real decoder.
if (captured.len > 0) {
  const full = (await send("Runtime.evaluate", {
    expression: "window.__dlb_stream.full || ''",
    returnByValue: true,
  })).result.value;

  const decoder = new DeepSeekStreamDecoder();
  const accumulator = new AnswerAccumulator();
  const parser = new ToolCallStreamParser([
    "fs.read_file", "fs.list_dir", "fs.write_file", "fs.search", "shell.exec", "http.request",
  ]);

  // Feed in small chunks, mimicking a streaming transport.
  let events = 0;
  for (let i = 0; i < full.length; i += 200) {
    const slice = full.slice(i, i + 200);
    for (const event of decoder.push(slice)) {
      events += 1;
      accumulator.apply(event);
      if (event.fragment === "response" && event.text) parser.push(event.text);
    }
  }

  console.log("\n=== decoder replay ===");
  console.log("events decoded:", events);
  console.log("thinking length:", accumulator.thinking.length);
  console.log("answer length:", accumulator.answer.length);
  console.log("finished:", accumulator.finished);
  console.log("tool calls found:", parser.calls.length);
  for (const call of parser.calls) {
    console.log("  ->", call.name, JSON.stringify(call.arguments));
  }
  console.log("answer text:", JSON.stringify(accumulator.answer.slice(-400)));
} else {
  console.log("\nNo response body was captured (the page may use a stream the XHR cannot expose).");
}

socket.close();
