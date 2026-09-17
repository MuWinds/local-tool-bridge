#!/usr/bin/env node
/**
 * Verifies the scrubber against the **live** page, in the live DOM.
 *
 * `verify-scrub.mjs` proves the pure string logic; this proves the DOM half —
 * that the content script actually removes injected plumbing from the rendered
 * transcript, that a reasoning tag is deleted from a thinking block, and that a
 * bubble left empty is hidden by the injected CSS.
 *
 * The reasoning case is exercised by inserting a thinking block shaped exactly
 * like the real one (`.ds-think-content > .ds-markdown > p > span`), because
 * whether the *model* puts a tag in its reasoning is not something a test can
 * decide. The scrubber reacts to the mutation either way.
 *
 * Usage: node scripts/verify-scrub-live.mjs
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);

async function findPage() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.find((t) => t.type === "page" && (t.url ?? "").includes("chat.deepseek.com")) ?? null;
}

const target = await findPage();
if (!target) {
  console.error("no chat.deepseek.com page target");
  process.exit(1);
}

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

async function evaluate(expression) {
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

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}`);
    if (detail !== undefined) console.log(`       ${String(detail).slice(0, 300)}`);
  }
}

// --- 1. The content script is present ---------------------------------------

console.log("\n[1] content script is live");
const styleText = await evaluate(
  `(document.getElementById('__dlb_scrub_styles__') || {}).textContent || null`,
);
check("scrub style injected", typeof styleText === "string" && styleText.length > 0, styleText);

// --- 2. Real transcript: no injected plumbing in any bubble -----------------

console.log("\n[2] real transcript bubbles");
const bubbles = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('.ds-message')].map((m) => ({
    hidden: m.getAttribute('data-dlb-empty') === '1',
    text: m.textContent || '',
  })))`),
);

if (bubbles.length === 0) {
  console.log("  info no messages on screen yet; skipping transcript checks");
} else {
  const leakedContract = bubbles.filter((b) => b.text.includes("你可以调用用户本机的工具"));
  const leakedResult = bubbles.filter((b) => b.text.includes("tool_result"));
  const leakedReminder = bubbles.filter((b) => b.text.includes("提醒：如需使用本机工具"));

  check("no bubble shows the injected contract", leakedContract.length === 0, leakedContract[0]?.text?.slice(0, 80));
  check("no bubble shows a tool_result block", leakedResult.length === 0, leakedResult[0]?.text?.slice(0, 80));
  check("no bubble shows the trailing reminder", leakedReminder.length === 0, leakedReminder[0]?.text?.slice(0, 80));
  check(
    "every visible bubble still has text",
    bubbles.filter((b) => !b.hidden).every((b) => b.text.trim().length > 0),
  );
}

// --- 3. A reasoning tag is deleted from a thinking block --------------------

console.log("\n[3] reasoning tag removal (live DOM)");
const TAG = '<fs_read_file>{"path":"C:\\\\tmp\\\\secret.txt"}</fs_read_file>';
const PROSE = "我需要读取那个文件，路径要转义。";

// Insert a thinking block shaped like the real one, then let the observer run.
await evaluate(`(() => {
  const message = document.querySelector('.ds-message');
  if (!message) return 'no-message';
  const block = document.createElement('div');
  block.className = 'ds-think-content';
  block.id = '__dlb_test_think__';
  const markdown = document.createElement('div');
  markdown.className = 'ds-markdown';
  const paragraph = document.createElement('p');
  paragraph.className = 'ds-markdown-paragraph';
  const span = document.createElement('span');
  span.textContent = ${JSON.stringify(PROSE + TAG)};
  paragraph.appendChild(span);
  markdown.appendChild(paragraph);
  block.appendChild(markdown);
  message.appendChild(block);
  return 'inserted';
})()`);

// The scrubber batches on requestAnimationFrame; a short wait is enough.
await new Promise((resolve) => setTimeout(resolve, 900));

const afterThink = await evaluate(
  `(() => {
    const block = document.getElementById('__dlb_test_think__');
    return block ? (block.textContent || '') : null;
  })()`,
);

check("thinking block still exists", afterThink !== null);
check("reasoning tag removed", afterThink !== null && !afterThink.includes("<fs_read_file>"), afterThink);
check("reasoning prose kept", afterThink !== null && afterThink.includes("我需要读取那个文件"), afterThink);

// --- 4. An emptied bubble is hidden by CSS ---------------------------------

console.log("\n[4] emptied bubble is hidden by CSS");
const hidden = await evaluate(`(() => {
  const probe = document.createElement('div');
  probe.className = 'ds-message';
  probe.id = '__dlb_test_bubble__';
  probe.setAttribute('data-dlb-empty', '1');
  document.body.appendChild(probe);
  const display = getComputedStyle(probe).display;
  probe.remove();
  return display;
})()`);

check("empty bubble computes to display:none", hidden === "none", hidden);

// --- 5. Clean up the synthetic nodes ---------------------------------------

await evaluate(`(() => {
  document.getElementById('__dlb_test_think__')?.remove();
  document.getElementById('__dlb_test_bubble__')?.remove();
  return 'cleaned';
})()`);

// --- 6. Does a Windows-path tag parse? (possible separate bug) --------------

console.log("\n[6] diagnostic: Windows-path tag parsing");
const sample = await evaluate(`(() => {
  const text = [...document.querySelectorAll('.ds-assistant-message-main-content')]
    .map((e) => e.textContent || '')
    .find((t) => t.includes('<fs_read_file>'));
  return text ? text.slice(0, 200) : null;
})()`);

if (sample === null) {
  console.log("  info no assistant tag on screen; skipping");
} else {
  console.log(`  info raw answer text: ${JSON.stringify(sample.slice(0, 120))}`);
}

socket.close();
console.log(failures === 0 ? "\nRESULT: live DOM checks passed." : `\nRESULT: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
