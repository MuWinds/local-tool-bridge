#!/usr/bin/env node
/**
 * Diagnoses *why* a tool-result bubble is briefly visible.
 *
 * The scrubber hides a bubble in two steps:
 *   1. delete the injected text from the DOM,
 *   2. stamp `data-dlb-empty="1"`, which a stylesheet maps to `display: none`.
 *
 * Both take effect inside a `requestAnimationFrame` callback, so the question is
 * what the page managed to paint *before* that callback ran. This script records,
 * for one live turn, the frame-by-frame text length together with the timestamp
 * of the last paint, which is what distinguishes "the scrub never ran" from "the
 * scrub ran one frame too late".
 *
 * Usage: node scripts/diagnose-bubble-timing.mjs "<message>" [observe-seconds]
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

// Record every DOM mutation that touches a user row, with its timestamp, plus the
// moment the row's text becomes non-empty. Comparing the two timelines tells us
// whether the scrub lagged the injection or never saw it.
await evaluate(
  send,
  `(() => {
    window.__dlbDiag = { events: [], started: Date.now() };
    const stamp = () => Date.now() - window.__dlbDiag.started;
    const note = (kind, detail) => {
      if (window.__dlbDiag.events.length > 4000) return;
      window.__dlbDiag.events.push({ t: stamp(), kind, ...detail });
    };

    const obs = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (!el) continue;
        const row = el.closest && el.closest('.ds-message');
        if (!row) continue;
        const isUser = row.parentElement && row.parentElement.className.includes('_9663006');
        if (!isUser) continue;
        note('mutation', {
          type: r.type,
          len: (row.textContent || '').length,
          flag: row.getAttribute('data-dlb-empty'),
          added: r.addedNodes ? r.addedNodes.length : 0,
          target: (el.className || el.tagName || '').toString().slice(0, 40),
        });
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-dlb-empty'] });
    window.__dlbDiag.obs = obs;

    // Paint ticker: how many frames elapse while a row is non-empty and visible.
    const tick = () => {
      const rows = [...document.querySelectorAll('.ds-message')]
        .filter(m => m.parentElement && m.parentElement.className.includes('_9663006'));
      const visiblePlumbing = rows.filter(m => {
        const t = m.textContent || '';
        return t.includes('tool_result') && m.getAttribute('data-dlb-empty') !== '1';
      }).length;
      if (visiblePlumbing > 0) note('visible-plumbing-frame', { count: visiblePlumbing });
      window.__dlbDiag.raf = requestAnimationFrame(tick);
    };
    tick();
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
  `(() => {
    cancelAnimationFrame(window.__dlbDiag.raf);
    window.__dlbDiag.obs.disconnect();
    return JSON.stringify(window.__dlbDiag.events);
  })()`,
);

const events = JSON.parse(raw);
const visibleFrames = events.filter((e) => e.kind === "visible-plumbing-frame");
const mutations = events.filter((e) => e.kind === "mutation");

console.log(`\nmutations on user rows: ${mutations.length}`);
console.log(`frames with visible plumbing: ${visibleFrames.length}`);

if (visibleFrames.length > 0) {
  console.log(
    `\n*** the injected tool_result text was PAINTED for ${visibleFrames.length} frames` +
      ` (t=${visibleFrames[0].t}ms .. t=${visibleFrames[visibleFrames.length - 1].t}ms) ***`,
  );
}

// Show the mutation that carried the text in, and what followed it.
const carrying = mutations.filter((m) => m.len > 60);
console.log(`\nmutations that brought in >60 chars (the tool result):`);
for (const m of carrying.slice(0, 12)) {
  console.log(
    `  t=${String(m.t).padStart(6)}ms type=${m.type} len=${String(m.len).padStart(5)} ` +
      `flag=${m.flag ?? "-"} added=${m.added} target=${m.target}`,
  );
}

// The flag transitions are the scrubber finally running.
const flagged = mutations.filter((m) => m.flag === "1");
console.log(`\nmoments the row was finally flagged data-dlb-empty=1:`);
for (const m of flagged.slice(0, 12)) {
  console.log(`  t=${String(m.t).padStart(6)}ms len=${m.len} target=${m.target}`);
}

socket.close();
