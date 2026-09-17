#!/usr/bin/env node
/**
 * Reads (and optionally fixes) the extension list in `chrome://extensions`, over CDP.
 *
 * ## Why this is needed
 *
 * `chrome.runtime.reload()` — the natural way to make a running Chrome pick up a
 * rebuilt unpacked extension — can leave the extension **disabled**. Chrome then
 * reports nothing anywhere else: `Extensions.loadUnpacked` still returns the id,
 * the extension still appears in the list, and the only symptom is that no
 * content script ever runs on the page. That looks exactly like a broken build.
 *
 * The extensions page carries the truth (`#card.disabled`), so it is read here,
 * and `--enable` flips the switch back.
 *
 * The whole exchange runs inside one attached session: `Runtime.evaluate` without
 * a `sessionId` is answered by the *browser* target, which has no `document` —
 * a failure that reads like "the WebUI changed" rather than "wrong target".
 *
 * Usage: node scripts/extensions-report.mjs [--enable]
 */

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const enable = process.argv.includes("--enable");

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);

let nextId = 0;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

await new Promise((resolve) => socket.addEventListener("open", resolve));

/** Sends one command, optionally inside an attached session. */
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    nextId += 1;
    const id = nextId;
    pending.set(id, { resolve, reject });
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    socket.send(JSON.stringify(frame));
  });

const { targetId } = await send("Target.createTarget", { url: "chrome://extensions/" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

/** Evaluates an expression in the extensions WebUI. */
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
  }
  return result.result.value;
}

// The WebUI needs a moment to build its shadow DOM.
await new Promise((resolve) => setTimeout(resolve, 2000));

const READ = `(() => {
  const manager = document.querySelector('extensions-manager');
  const list = manager?.shadowRoot?.querySelector('extensions-item-list');
  const items = [...(list?.shadowRoot?.querySelectorAll('extensions-item') ?? [])];
  return items.map((item) => {
    const root = item.shadowRoot;
    const card = root?.querySelector('#card');
    const detail = manager?.shadowRoot?.querySelector('extensions-detail-view');
    return {
      id: item.getAttribute('id'),
      name: root?.querySelector('#name')?.textContent?.trim() ?? null,
      description: root?.querySelector('#description')?.textContent?.trim() ?? null,
      disabled: card?.classList.contains('disabled') ?? null,
      removable: root?.querySelector('#remove-button') !== null,
      errorButton: root?.querySelector('#errors-button')?.textContent?.trim() ?? null,
      // The details view carries the version and the source path; it is built
      // only for the selected item, so this is best-effort.
      version: detail?.shadowRoot?.querySelector('#version')?.textContent?.trim() ?? null,
      path: detail?.shadowRoot?.querySelector('#source')?.textContent?.trim() ?? null,
    };
  });
})()`;

if (enable) {
  // The toolbar toggle is a `<cr-toggle>` inside the item's shadow root. Its
  // click handler is the same one a user's click runs, so this is the supported
  // path rather than a preference poke.
  const clicked = await evaluate(`(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager?.shadowRoot?.querySelector('extensions-item-list');
    const items = [...(list?.shadowRoot?.querySelectorAll('extensions-item') ?? [])];
    const targeted = items.filter((item) => item.shadowRoot?.querySelector('#card')?.classList.contains('disabled'));
    for (const item of targeted) {
      const toggle = item.shadowRoot?.querySelector('#enableToggle, cr-toggle');
      toggle?.click();
    }
    return targeted.length;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log(`clicked enable on ${clicked} disabled extension(s)`);
}

console.log(JSON.stringify(await evaluate(READ), null, 2));

await send("Target.closeTarget", { targetId }).catch(() => {});
socket.close();
