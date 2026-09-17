#!/usr/bin/env node
/**
 * Drives one real message through the page and reports what the bridge did.
 *
 * This is the end-to-end check the unit tests cannot give: it types into the
 * real composer, lets the page send, and then inspects the transcript to confirm
 * (a) the tool actually ran, and (b) the injected plumbing was scrubbed out of
 * what the user sees.
 *
 * Usage: node scripts/drive-conversation.mjs "<message>" [wait-seconds]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const message = process.argv[2] ?? "读一下 dlb-test-workspace/notes.txt 并告诉我里面的 token";
const waitSeconds = Number(process.argv[3] ?? 60);

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

// Type into the real composer, going through the native setter so React notices.
const typed = await evaluate(
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
console.log(`typing: ${typed}`);

await new Promise((resolve) => setTimeout(resolve, 600));

// Click the send control by geometry, the same way the bridge does.
const sent = await evaluate(
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
console.log(`sending: ${sent}`);

console.log(`waiting ${waitSeconds}s for the exchange...`);
await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

// Report what is actually on screen.
const report = await evaluate(
  send,
  `(() => {
    const messages = [...document.querySelectorAll('.ds-message')];
    return JSON.stringify({
      messageCount: messages.length,
      emptyBubbles: document.querySelectorAll('.ds-message[data-dlb-empty="1"]').length,
      scrubStylePresent: !!document.getElementById('__dlb_scrub_styles__'),
      bubbles: messages.map((m, i) => ({
        i,
        hidden: m.getAttribute('data-dlb-empty') === '1',
        len: (m.textContent || '').length,
        hasContract: (m.textContent || '').includes('你可以调用用户本机的工具'),
        hasToolResult: (m.textContent || '').includes('tool_result'),
        hasReminder: (m.textContent || '').includes('提醒：如需使用本机工具'),
        thinkTags: [...m.querySelectorAll('.ds-think-content')]
          .map(t => (t.textContent || '').match(/<fs_[a-z_]+>/g) || []).flat(),
        head: (m.textContent || '').slice(0, 70),
      })),
    });
  })()`,
);

console.log("\n" + JSON.stringify(JSON.parse(report), null, 2));
socket.close();
