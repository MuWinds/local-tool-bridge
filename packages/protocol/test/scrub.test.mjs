/**
 * Tests for the presentation scrubber.
 *
 * These pin down the two behaviours the UI depends on: the bridge's injected
 * text disappears, and the user's own writing never does. The second half matters
 * more — a scrubber that over-deletes silently destroys what someone typed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chatMLTokenRanges,
  deleteRanges,
  findInjectedRanges,
  findToolTagRanges,
  mayContainInjectedText,
  scrubInjectedText,
} from "../dist/index.js";

const TOOLS = ["fs.read_file", "fs.list_dir", "fs.write_file", "fs.search", "shell.exec", "http.request"];

const CONTRACT = [
  "你可以调用用户本机的工具。调用方式如下 —— 一个 `<tool_calls>` 包装，里面每个 `<invoke>` 是一次调用：",
  "",
  "<tool_calls>",
  '<invoke name="fs_list_dir">',
  '<parameter name="path" string="true">参数值</parameter>',
  "</invoke>",
  "</tool_calls>",
  "",
  "严格遵守以下规则：",
  "1. 必须使用 <tool_calls> / <invoke name=\"…\"> / <parameter name=\"…\"> 这三个标签。",
].join("\n");

const REMINDER =
  '提醒：如需使用本机工具，请在**最终回答**里直接输出 <tool_calls><invoke name="fs_list_dir"><parameter name="path">路径</parameter></invoke></tool_calls>；不要写进思考过程。';

test("removes the contract and reminder while keeping the user's question", () => {
  const text = [CONTRACT, "", "---", "", "帮我看看 C:\\tmp 里有什么", "", "---", "", REMINDER].join("\n");

  const out = scrubInjectedText(text, { systemPrompt: CONTRACT, reminder: REMINDER });

  assert.equal(out, "帮我看看 C:\\tmp 里有什么");
});

test("removes a tool-result block and its footer", () => {
  const text = [
    '<tool_result name="fs.read_file" status="ok">',
    "     1\tProject: Local Tool Bridge",
    "     2\tSecret token: ZEBRA-7741",
    "</tool_result>",
    "",
    "以上是本机工具的执行结果，请据此继续回答。",
  ].join("\n");

  assert.equal(scrubInjectedText(text), "");
});

test("keepToolResults preserves the whole result turn for the card renderer", () => {
  const text = [
    '<tool_result name="fs.list_dir" status="ok">',
    "a.txt",
    "</tool_result>",
    "",
    "以上是本机工具的执行结果，请据此继续回答。",
  ].join("\n");

  // The content script asks for this: the result turn is content, not plumbing,
  // and deleting it — or just deleting the footer, which drags the block above it
  // along — is what made the turn vanish.
  const out = scrubInjectedText(text, { keepToolResults: true });
  assert.match(out, /<tool_result name="fs\.list_dir" status="ok">/);
  assert.match(out, /a\.txt/);
  assert.match(out, /以上是本机工具的执行结果/);
});

test("keeps user text that surrounds a tool result", () => {
  const text = [
    "这是我之前粘贴的内容",
    '<tool_result name="fs.list_dir" status="ok">',
    "a.txt",
    "</tool_result>",
    "以及后面的说明",
  ].join("\n");

  const out = scrubInjectedText(text);
  assert.match(out, /这是我之前粘贴的内容/);
  assert.match(out, /以及后面的说明/);
  assert.doesNotMatch(out, /tool_result/);
});

test("handles two adjacent tool-result blocks without swallowing the gap", () => {
  const text =
    '<tool_result name="fs.list_dir" status="ok">A</tool_result>' +
    '<tool_result name="fs.search" status="ok">B</tool_result>';

  assert.equal(scrubInjectedText(text), "");
});

test("leaves a message with no injected text byte-identical", () => {
  const text = "只是一句普通的话\n带换行和 <div> 这样的标签";

  assert.equal(scrubInjectedText(text, { systemPrompt: CONTRACT, reminder: REMINDER }), text);
});

test("does not delete a user's own markdown bullet list", () => {
  const text = ["- 第一项", "- 第二项", "", "就这些"].join("\n");

  assert.equal(scrubInjectedText(text, { systemPrompt: CONTRACT }), text);
});

test("removes the separator lines that bracketed the contract", () => {
  const text = [CONTRACT, "", "---", "", "真正的问题"].join("\n");

  const out = scrubInjectedText(text, { systemPrompt: CONTRACT });
  assert.equal(out, "真正的问题");
  assert.doesNotMatch(out, /---/);
});

test("keeps a horizontal rule the user wrote themselves", () => {
  const text = ["我的问题", "", "---", "", "补充说明"].join("\n");

  assert.equal(scrubInjectedText(text, { systemPrompt: CONTRACT }), text);
});

test("findInjectedRanges returns offsets into the original text", () => {
  const text = [CONTRACT, "USER", REMINDER].join("\n");
  const ranges = findInjectedRanges(text, { systemPrompt: CONTRACT, reminder: REMINDER });

  // `deleteRanges` is the raw primitive the DOM layer uses, so it keeps the
  // whitespace between the removed blocks; `scrubInjectedText` tidies it after.
  const raw = deleteRanges(text, ranges);
  assert.match(raw, /USER/);
  assert.doesNotMatch(raw, /工具名就是标签名/);
  assert.doesNotMatch(raw, /提醒：/);

  assert.equal(raw.trim(), scrubInjectedText(text, { systemPrompt: CONTRACT, reminder: REMINDER }));
});

test("finds a tool call in reasoning, but only for known tools", () => {
  const text =
    '让我列出目录。<tool_calls><invoke name="fs_list_dir"><parameter name="path">C:\\tmp</parameter></invoke></tool_calls>';

  const known = findToolTagRanges(text, TOOLS);
  // The wrapper goes with the call, so no empty `<tool_calls>` shell is left.
  assert.equal(deleteRanges(text, known), "让我列出目录。");

  // An unknown tool name is inert and must survive, since arbitrary XML is
  // expected on the page.
  assert.deepEqual(findToolTagRanges(text, ["other.tool"]), []);
});

test("does not treat a code sample as a call", () => {
  const text = "示例：<span>hello</span> 和 <div>world</div>";
  assert.deepEqual(findToolTagRanges(text, TOOLS), []);
});

test("mayContainInjectedText is a cheap prefilter, not a verdict", () => {
  assert.equal(mayContainInjectedText("普通文本"), false);
  assert.equal(mayContainInjectedText('<tool_result name="x">y</tool_result>'), true);
  assert.equal(mayContainInjectedText(CONTRACT, { systemPrompt: CONTRACT }), true);
});

test("merges overlapping ranges so deletion cannot double-count", () => {
  const ranges = findInjectedRanges(
    `${CONTRACT}\n${CONTRACT}`,
    { systemPrompt: CONTRACT },
  );
  assert.ok(ranges.length >= 1);
  for (const [start, end] of ranges) assert.ok(end > start);
});

test("chatMLTokenRanges removes the wrapper lines around the question", () => {
  const prompt = `<｜System｜>\n${CONTRACT}\n<｜end▁of▁sentence｜>\n<｜User｜>\n帮我看看 C:\\tmp 里有什么\n<｜end▁of▁sentence｜><｜Assistant｜>`;
  // The full scrub flow: line-based contract deletion first, then the inline
  // ChatML wrapper cleanup.
  const injected = deleteRanges(prompt, findInjectedRanges(prompt, { systemPrompt: CONTRACT }));
  const out = deleteRanges(injected, chatMLTokenRanges(injected));
  assert.equal(out, "帮我看看 C:\\tmp 里有什么");
});

test("chatMLTokenRanges leaves a token inside running text alone", () => {
  const text = "用户自己粘贴的 <｜Assistant｜> 说明文字";
  const ranges = chatMLTokenRanges(text);
  assert.equal(ranges.length, 1);
  const out = deleteRanges(text, ranges);
  assert.equal(out, "用户自己粘贴的  说明文字");
});
