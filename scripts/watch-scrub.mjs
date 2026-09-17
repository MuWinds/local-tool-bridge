#!/usr/bin/env node
/**
 * Watches a live tool-result turn frame by frame.
 *
 * The scrubber hides a bubble by setting `data-dlb-empty="1"` on the
 * `.ds-message` element, and a stylesheet turns that into `display: none`.
 * Whether that survives depends on ordering between the scrub pass and the
 * page's virtual-list render, which a single end-state snapshot cannot show.
 *
 * This records the attribute, the computed display, and the text length of every
 * user message on every animation frame, then reports the transitions. A bubble
 * that is flagged and later loses the flag is the failure being hunted: it is the
 * signature of the page re-rendering the row after the scrubber ran.
 *
 * Usage: node scripts/watch-scrub.mjs "<message>" [observe-seconds]
 */

import { writeFileSync } from "node:fs";

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const message = process.argv[2] ?? "列一下当前目录";
const observeSeconds = Number(process.argv[3] ?? 90);

/** Opens a CDP session with a promise-based `send`. */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(JSON.stringify(data.error)));
    else entry.resolve(data.result);
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

async function findPage() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.find((t) => t.type === "page" && (t.url ?? "").includes("chat.deepseek.com")) ?? null;
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
    );
  }
  return result.result.value;
}

const target = await findPage();
if (!target) {
  console.error("no chat.deepseek.com page target");
  process.exit(1);
}

const { socket, send } = await connect(target);
await send("Runtime.enable");

// Install a recorder in the page that samples the user bubbles every frame.
await evaluate(
  send,
  `(() => {
    window.__dlbWatch = { samples: [], started: Date.now() };
    const sample = () => {
      const rows = [...document.querySelectorAll('.ds-message')]
        .filter(m => m.parentElement && m.parentElement.className.includes('_9663006'));
      window.__dlbWatch.samples.push({
        t: Date.now() - window.__dlbWatch.started,
        rows: rows.map(m => ({
          flag: m.getAttribute('data-dlb-empty'),
          disp: getComputedStyle(m).display,
          len: (m.textContent || '').length,
          vis: m.getBoundingClientRect().height > 0,
        })),
      });
      window.__dlbWatch.raf = requestAnimationFrame(sample);
    };
    sample();
    return 'watching';
  })()`,
);

console.log("recorder installed; sending message");

await evaluate(
  send,
  `(() => {
    const textarea = document.querySelector('textarea');
    if (!textarea) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    textarea.focus();
    setter.call(textarea, ${JSON.stringify(message)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`,
);

await new Promise((resolve) => setTimeout(resolve, 600));

await evaluate(
  send,
  `(() => {
    const textarea = document.querySelector('textarea');
    const box = textarea.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('div[role="button"], button')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => {
        if (rect.width <= 0 || rect.height <= 0) return false;
        return rect.top >= box.top - 24 && rect.bottom <= box.bottom + 64 && rect.left > box.left + box.width * 0.5;
      })
      .sort((a, b) => b.rect.left - a.rect.left);
    if (!candidates.length) return 'no-send-button';
    candidates[0].element.click();
    return 'clicked';
  })()`,
);

console.log(`observing for ${observeSeconds}s...`);
await new Promise((resolve) => setTimeout(resolve, observeSeconds * 1000));

const raw = await evaluate(
  send,
  `(() => {
    cancelAnimationFrame(window.__dlbWatch.raf);
    return JSON.stringify(window.__dlbWatch.samples);
  })()`,
);

const samples = JSON.parse(raw);
writeFileSync("scrub-watch.json", JSON.stringify(samples, null, 1));

// Collapse the frame stream into state transitions per row index.
const transitions = [];
let previous = null;
for (const s of samples) {
  const key = JSON.stringify(s.rows);
  if (key !== previous) {
    transitions.push({ t: s.t, rows: s.rows });
    previous = key;
  }
}

console.log(`\nframes=${samples.length} transitions=${transitions.length}\n`);
for (const t of transitions.slice(-40)) {
  console.log(
    `t=${String(t.t).padStart(6)}ms  ` +
      t.rows
        .map((r, i) => `[${i}] flag=${r.flag ?? "-"} disp=${r.disp} len=${r.len}`)
        .join("  "),
  );
}

socket.close();
