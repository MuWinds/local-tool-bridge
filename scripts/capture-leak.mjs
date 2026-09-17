#!/usr/bin/env node
/**
 * Captures the exact text of a user-turn bubble during the window in which the
 * scrubber has not yet hidden it.
 *
 * The end-state is always clean, so an after-the-fact inspection says the scrub
 * worked. This samples the *text* every frame and stores the first moment each
 * row carried content, which is what actually reaches the user's screen.
 *
 * Usage: node scripts/capture-leak.mjs "<message>" [observe-seconds]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const message = process.argv[2] ?? "列一下当前目录";
const observeSeconds = Number(process.argv[3] ?? 70);

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

await evaluate(
  send,
  `(() => {
    window.__dlbLeak = { entries: [], started: Date.now() };
    const sample = () => {
      const rows = [...document.querySelectorAll('.ds-message')]
        .filter(m => m.parentElement && m.parentElement.className.includes('_9663006'));
      for (const [i, m] of rows.entries()) {
        const text = m.textContent || '';
        if (text.length === 0) continue;
        const key = i + ':' + text.length;
        if (window.__dlbLeak.seen === undefined) window.__dlbLeak.seen = new Set();
        if (window.__dlbLeak.seen.has(key)) continue;
        window.__dlbLeak.seen.add(key);
        window.__dlbLeak.entries.push({
          t: Date.now() - window.__dlbLeak.started,
          row: i,
          len: text.length,
          flag: m.getAttribute('data-dlb-empty'),
          disp: getComputedStyle(m).display,
          text: text.slice(0, 700),
        });
      }
      window.__dlbLeak.raf = requestAnimationFrame(sample);
    };
    sample();
    return 'ok';
  })()`,
);

await evaluate(
  send,
  `(() => {
    const textarea = document.querySelector('textarea');
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

console.log(`observing ${observeSeconds}s...`);
await new Promise((resolve) => setTimeout(resolve, observeSeconds * 1000));

const raw = await evaluate(
  send,
  `(() => { cancelAnimationFrame(window.__dlbLeak.raf); return JSON.stringify(window.__dlbLeak.entries); })()`,
);

const entries = JSON.parse(raw);
console.log(`\n${entries.length} distinct (row,length) observations while non-empty:\n`);
for (const e of entries) {
  const leaked = e.flag !== "1" && e.disp !== "none";
  console.log(
    `t=${String(e.t).padStart(6)}ms row=${e.row} len=${String(e.len).padStart(5)} ` +
      `flag=${e.flag ?? "-"} disp=${String(e.disp).padEnd(5)} ${leaked ? "*** VISIBLE ***" : "(hidden)"}`,
  );
  if (leaked) console.log(`        text: ${JSON.stringify(e.text.slice(0, 200))}`);
}

socket.close();
