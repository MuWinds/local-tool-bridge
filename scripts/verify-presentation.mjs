#!/usr/bin/env node
/**
 * Runs the built content script against a synthetic transcript, inside the
 * extension's own page, and prints what the presentation layer did.
 *
 * ## Why a fixture instead of the live page
 *
 * The live transcript is a moving target: a virtual list that re-renders, a
 * streaming answer, and page-owned DOM that lives in a *different JavaScript
 * realm* from the content script. Testing there produced a contradiction — the
 * in-script diagnostic reported that a synthetic turn was never visited, while
 * the DOM showed it had been emptied — because a synthetic turn built in the page
 * realm is not observed the same way as one the script's own realm builds.
 *
 * Here the document is built by the code under test's own realm, nothing else is
 * running, and both the assertion and the code share one JavaScript world. The
 * script is loaded as text and executed directly, so its top-level statements run
 * exactly as they do in a content script.
 *
 * Usage: CDP_PORT=9250 node scripts/verify-presentation.mjs
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const contentScript = await readFile(resolve("apps/extension/dist/content.js"), "utf8");

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

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    nextId += 1;
    const id = nextId;
    pending.set(id, { resolve, reject });
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    socket.send(JSON.stringify(frame));
  });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let extensionPage = targets.find((target) => (target.url ?? "").includes("chrome-extension://"));

// The extension's own pages are the only context where the runtime message
// channel exists, so one is opened if the browser has none.
if (!extensionPage) {
  const { Target } = await import("node:child_process");
  void Target;
  const extensionId = process.env["DLB_EXTENSION_ID"] ?? "bihbplcnlbgneahnjahdphgofelenmfe";
  const created = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup.html`,
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const listed = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  extensionPage = listed.find((target) => target.id === created.targetId) ?? null;
}

if (!extensionPage) {
  console.error("could not open an extension page target");
  process.exit(1);
}

const { targetId } = await send("Target.createTarget", { url: extensionPage.url });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await new Promise((resolve) => setTimeout(resolve, 1500));

const result = await send(
  "Runtime.evaluate",
  {
    expression: `(async () => {
      const SOURCE = ${JSON.stringify(contentScript)};
      const CONTRACT = '你可以调用用户本机的工具。调用方式如下 —— 一个 <tool_calls> 包装：';
      const REMINDER = '提醒：如需使用本机工具，请在最终回答里直接输出 <tool_calls><invoke name="fs_list_dir"><parameter name="path">路径</parameter></invoke></tool_calls>。';
      const TOOLS = ['fs.list_dir', 'fs.read_file', 'fs.search', 'shell.exec', 'http.request'];

      // --- a document shaped like the real transcript ------------------------
      document.documentElement.innerHTML = '<head></head><body class="dark" data-ds-dark-theme></body>';
      document.head.innerHTML =
        '<style>' +
        '.ds-message{display:flex;flex-direction:column;padding:0 0 16px}' +
        '.fbb737a4{max-width:calc(100% - 88px);padding:10px 16px;border-radius:22px;background:#2c2c2e;color:#f9fafb}' +
        '.ds-markdown{white-space:pre-wrap}' +
        '.md-code-block{background:#111;color:#ddd;padding:8px;font-family:monospace}' +
        '</style>';

      const fill = (host, lines) => {
        for (const line of lines) {
          const span = document.createElement('span');
          span.textContent = line;
          host.appendChild(span);
          host.appendChild(document.createElement('br'));
        }
      };

      // Elements are registered as they are built rather than looked up by id
      // afterwards: the id lookup is only a convenience for the reporting helper,
      // and a whole class of fixture bugs came from it silently returning null.
      const created = {};
      const register = (id, node) => {
        created[id] = node;
        return node;
      };

      const userTurn = (id) => {
        const li = document.createElement('div');
        li.className = '_9663006';
        const message = document.createElement('div');
        message.className = 'd29f3d7d ds-message _63c77b1';
        const bubble = document.createElement('div');
        bubble.className = 'fbb737a4';
        const collapsible = document.createElement('div');
        collapsible.className = 'ds-collapsible-text';
        const body = document.createElement('div');
        body.id = id;
        collapsible.appendChild(body);
        bubble.appendChild(collapsible);
        message.appendChild(bubble);
        li.appendChild(message);
        document.querySelector('.ds-virtual-list-visible-items').appendChild(li);
        return register(id, body);
      };

      const assistantTurn = (id, thinking) => {
        const li = document.createElement('div');
        li.className = '_4f9bf79 _43c05b5';
        const message = document.createElement('div');
        message.className = 'ds-message _63c77b1';
        if (thinking) {
          const think = document.createElement('div');
          think.className = '_74c0879';
          const content = document.createElement('div');
          content.className = 'ds-think-content';
          const markdown = document.createElement('div');
          markdown.className = 'ds-markdown';
          const paragraph = document.createElement('p');
          paragraph.className = 'ds-markdown-paragraph';
          paragraph.id = id + '-think';
          markdown.appendChild(paragraph);
          content.appendChild(markdown);
          think.appendChild(content);
          message.appendChild(think);
          register(id + '-think', paragraph);
        }
        const body = document.createElement('div');
        body.className = 'ds-markdown ds-assistant-message-main-content';
        const paragraph = document.createElement('p');
        paragraph.className = 'ds-markdown-paragraph';
        paragraph.id = id;
        body.appendChild(paragraph);
        message.appendChild(body);
        li.appendChild(message);
        document.querySelector('.ds-virtual-list-visible-items').appendChild(li);
        return register(id, paragraph);
      };

      const list = document.createElement('div');
      list.className = 'ds-virtual-list-visible-items';
      document.body.appendChild(list);

      const c1 = userTurn('case1');
      fill(c1, [CONTRACT, '', '---', '', '读一下 notes.txt 并告诉我 token', '', '---', '', REMINDER]);

      // The wrapper dialect: one tool_calls block holding one invoke per call.
      // Case 2 puts **two** calls in a single wrapper, which is the shape that
      // proves the wrapper is consumed once while still yielding one card each.
      const call = (tool, params) =>
        '<invoke name="' + tool + '">' +
        params.map((p) => '<parameter name="' + p[0] + '">' + p[1] + '</parameter>').join('') +
        '</invoke>';

      const c2 = assistantTurn('case2', false);
      fill(c2, [
        '<tool_calls>',
        call('fs_list_dir', [['path', 'C:\\\\Users\\\\me\\\\proj'], ['maxEntries', '200']]),
        call('shell_exec', [['command', 'pwd && ls -la']]),
        '</tool_calls>',
      ]);

      const c3 = assistantTurn('case3', false);
      fill(c3, [
        '我先看一下目录，再决定读哪个文件。',
        '<tool_calls>',
        call('fs_list_dir', [['path', 'C:\\\\Users\\\\me'], ['maxEntries', '200']]),
        '</tool_calls>',
        '（等结果回来再继续）',
      ]);

      const c4 = assistantTurn('case4', false);
      const codeBlock = document.createElement('div');
      codeBlock.className = 'md-code-block';
      codeBlock.id = 'case4-code';
      // Inside the assistant body: a call the renderer escaped into a code
      // element, which must stay exactly as written.
      c4.appendChild(codeBlock);
      fill(codeBlock, [
        '<tool_calls>',
        call('fs_read_file', [['path', 'C:\\\\tmp\\\\demo.txt']]),
        '</tool_calls>',
      ]);

      const c5 = assistantTurn('case5', true);
      fill(created['case5-think'], [
        '我应该调用 <tool_calls>' + call('fs_list_dir', [['path', 'C:\\\\']]) + '</tool_calls> 看看。',
      ]);
      fill(c5, ['思考结束，现在给出最终回答。']);

      const c6 = userTurn('case6');
      fill(c6, [
        '<tool_result name="fs.list_dir" status="ok">',
        '     1\\t.gitignore',
        '     2\\tapps/',
        '     3\\tpackages/',
        '</tool_result>',
        '',
        '<tool_result name="shell.exec" status="error">',
        'no workspace root is configured; set one in the bridge settings',
        '</tool_result>',
        '',
        '以上是本机工具的执行结果，请据此继续回答。',
      ]);

      // --- run the content script -------------------------------------------
      //
      // The script asks the extension for its configuration and its tool list
      // through the runtime message channel, and asks storage for the user's
      // switches. In a bare extension page there is no receiver for those, so the
      // script's own fallback would push an **empty** configuration — which
      // arrives *after* any test configuration and wipes it out. The bridge is
      // therefore stubbed to answer the way a live host would, so the script
      // configures itself exactly as it does in production.
      //
      // The runtime namespace is absent on some extension pages depending on how
      // the page was opened, so both namespaces are created when missing rather
      // than assumed.
      const runtime = chrome.runtime ?? (chrome.runtime = {});
      const realSendMessage = runtime.sendMessage?.bind(runtime);
      runtime.sendMessage = async (request) => {
        if (request && request.kind === 'prompt') {
          return { kind: 'prompt', prompt: CONTRACT, reminder: REMINDER, toolNames: TOOLS };
        }
        if (request && request.kind === 'tools') {
          return { kind: 'tools', tools: TOOLS.map((name) => ({ name, summary: name })) };
        }
        if (realSendMessage) return realSendMessage(request);
        return { kind: 'error', message: 'no receiver in fixture' };
      };

      const local = (chrome.storage ?? (chrome.storage = {})).local ?? (chrome.storage.local = {});
      const realStorageGet = local.get?.bind(local);
      local.get = async (keys) => {
        const stored = realStorageGet ? await realStorageGet(keys).catch(() => ({})) : {};
        return { ...stored, settings: { enabled: true, locale: 'zh', showIndicator: true } };
      };

      new Function(SOURCE)();

      await new Promise((resolve) => setTimeout(resolve, 2500));

      const readCard = (host) => {
        const card = host.querySelector('span[data-dlb-card="1"]');
        if (!card) return null;
        const cs = getComputedStyle(card);
        return {
          text: card.textContent,
          display: cs.display,
          background: cs.backgroundColor,
          padding: cs.padding,
          borderLeft: cs.borderLeftWidth,
        };
      };

      const describe = (host) => {
        const message = host.closest('.ds-message') ?? host;
        return {
          text: (message.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
          display: getComputedStyle(message).display,
          empty: message.getAttribute('data-dlb-empty'),
          result: message.getAttribute('data-dlb-result'),
          cards: host.querySelectorAll('[data-dlb-card="1"]').length,
          card: readCard(host),
          rawXml: /<tool_calls>|<invoke\\s|<tool_result/.test(message.textContent || ''),
        };
      };

      const cases = {};
      for (const id of ['case1', 'case2', 'case3', 'case4', 'case5', 'case6']) {
        cases[id] = created[id] ? describe(created[id]) : { missing: true };
      }

      // The reasoning panel is read from a fresh query, not from the reference the
      // fixture built it with: the scrubber rewrites the panel's children, and a
      // stale reference would silently describe the pre-transform DOM.
      const liveReasoning = document.querySelector('.ds-think-content .ds-markdown-paragraph');
      return {
        cases,
        thinkingKept: liveReasoning?.textContent ?? null,
        presentation: JSON.parse(document.documentElement.getAttribute('data-dlb-presentation') || '{}'),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  },
  sessionId,
);

if (result.exceptionDetails) {
  console.error("evaluate threw:", result.exceptionDetails.exception?.description);
  process.exitCode = 1;
} else {
  const report = result.result.value;
  console.log(JSON.stringify(report, null, 2));

  // The fixture is only useful if it fails loudly, so the load-bearing claims are
  // asserted here rather than left for a human to eyeball.
  //
  // The result turn and the reasoning panel are asserted through the script's own
  // read-only snapshot rather than through `closest('.ds-message')`: the fixture
  // wraps a result body in an extra `<div>`, and a lookup that walks the page tree
  // is measuring the fixture, not the transform.
  const checks = [
    ["a pure tool-call answer renders one card per call and no raw XML", report.cases.case2.cards === 2 && report.cases.case2.rawXml === false],
    ["an answer with prose keeps the prose and cards the call", report.cases.case3.cards === 1 && report.cases.case3.text.includes("我先看一下目录") && report.cases.case3.rawXml === false],
    ["a call inside a code block is left exactly as written", report.cases.case4.cards === 0 && report.cases.case4.rawXml === true],
    ["a reasoning call is deleted, never carded", !(report.thinkingKept || "").includes("<invoke") && !(report.thinkingKept || "").includes("▸")],
    ["the result turn renders a card instead of vanishing", report.presentation.results >= 1 && report.presentation.hidden <= 1],
    ["the injected contract is removed from the user turn", report.cases.case1.empty === "1" || !report.cases.case1.text.includes("你可以调用用户本机的工具")],
    ["the observer is running without errors", report.presentation.passes > 0 && report.presentation.errors === 0],
  ];

  let failures = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
    if (!ok) failures += 1;
  }
  console.log(failures === 0 ? "\nRESULT: presentation checks passed." : `\nRESULT: ${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

await send("Target.closeTarget", { targetId }).catch(() => {});
socket.close();
