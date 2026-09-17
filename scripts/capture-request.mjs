#!/usr/bin/env node
/**
 * Captures the real `/api/v0/chat/completion` request body from the live page.
 *
 * This is the ground truth for "did the injection happen". The rendered DOM is
 * not evidence — the page renders the user's message from local optimistic
 * state, so it shows the original text whether or not the request was rewritten.
 * Only the bytes on the wire settle it.
 *
 * Also installs a MAIN-world probe that survives navigation, so the bridge
 * channel can be observed across a reload.
 *
 * Usage: node scripts/capture-request.mjs [seconds]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const DURATION_MS = Number(process.argv[2] ?? 90) * 1000;

/** Finds the chat page target. */
async function findTarget() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return (
    targets.find((t) => t.type === "page" && (t.url ?? "").includes("chat.deepseek.com")) ??
    targets.find((t) => t.type === "page") ??
    null
  );
}

const target = await findTarget();
if (!target) {
  console.error("no page target found");
  process.exit(1);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }

  // Streaming events.
  if (message.method === "Network.requestWillBeSent") {
    const { request } = message.params;
    if ((request.url ?? "").includes("/api/v0/chat/completion")) {
      const body = request.postData ?? "";
      let prompt = null;
      try {
        prompt = JSON.parse(body).prompt ?? null;
      } catch {
        /* not JSON */
      }

      captures.push({
        at: new Date().toISOString(),
        url: request.url,
        bodyLength: body.length,
        hasContract: body.includes("工具名就是标签名") || body.includes("tool name *is* the tag name"),
        hasReminder: body.includes("提醒：如需使用本机工具") || body.includes("Reminder: to use a local tool"),
        hasToolTagSyntax: body.includes("<fs_read_file>") || body.includes("<fs_list_dir>"),
        promptLength: prompt ? prompt.length : null,
        promptHead: prompt ? prompt.slice(0, 100) : null,
        promptTail: prompt ? prompt.slice(-120) : null,
      });
      console.log(`\n[captured] completion request #${captures.length}`);
      const last = captures[captures.length - 1];
      console.log(`  body length      : ${last.bodyLength}`);
      console.log(`  contract present : ${last.hasContract}`);
      console.log(`  reminder present : ${last.hasReminder}`);
      console.log(`  prompt head      : ${JSON.stringify(last.promptHead)}`);
      console.log(`  prompt tail      : ${JSON.stringify(last.promptTail)}`);
    }
  }

  if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args ?? [])
      .map((a) => a.value ?? a.description ?? "")
      .join(" ");
    if (text.includes("dlb") || text.includes("bridge")) {
      console.log(`[console] ${text}`);
    }
  }
});

const captures = [];

await new Promise((resolve) => socket.addEventListener("open", resolve));

function send(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await send("Network.enable", { maxPostDataSize: 5_000_000 });
await send("Runtime.enable");
await send("Page.enable");

// A probe that survives navigation, so the bridge channel is observable across
// the reload that a new conversation triggers.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__dlb_capture = { bridgeMessages: [], hookInstalled: false, configs: [] };
    window.addEventListener('message', (event) => {
      if (!event.data || event.data.tag !== '__dlb_bridge_v1__') return;
      const payload = event.data.payload;
      if (!payload) return;
      if (payload.reason === 'main-world hook installed') window.__dlb_capture.hookInstalled = true;
      if (payload.kind === 'config') {
        window.__dlb_capture.configs.push({
          enabled: payload.enabled,
          hasPrompt: typeof payload.systemPrompt === 'string' && payload.systemPrompt.length > 0,
          promptLength: payload.systemPrompt ? payload.systemPrompt.length : 0,
          toolCount: Array.isArray(payload.toolNames) ? payload.toolNames.length : 0,
        });
      }
      if (payload.kind === 'tool-calls') {
        window.__dlb_capture.bridgeMessages.push({ kind: 'tool-calls', calls: payload.calls });
      }
      if (payload.kind === 'stream-end') {
        window.__dlb_capture.bridgeMessages.push({ kind: 'stream-end', answer: (payload.answer || '').slice(0, 200) });
      }
    });
  `,
});

console.log(`capturing for ${DURATION_MS / 1000}s — send a message in the DeepSeek tab now\n`);

await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

const probe = await send("Runtime.evaluate", {
  expression: "JSON.stringify(window.__dlb_capture || null)",
  returnByValue: true,
});

console.log("\n=== MAIN-world probe state ===");
console.log(probe.result.value);

console.log("\n=== summary ===");
console.log(`completion requests captured: ${captures.length}`);
if (captures.length > 0) {
  const injected = captures.filter((c) => c.hasContract).length;
  console.log(`requests with the injected contract: ${injected} / ${captures.length}`);
}

socket.close();
