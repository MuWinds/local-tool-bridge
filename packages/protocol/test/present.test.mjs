/**
 * Tests for the presentation transform.
 *
 * The property that matters most is **idempotence**: the content script re-runs
 * this transform on every DOM mutation, so a second pass over already-rendered
 * output must be a byte-identical no-op. The second is preservation: a tag the
 * user pasted, or one inside a code fence, must never be relabelled as a call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CALL_CARD_MARK,
  RESULT_CARD_MARK,
  buildToolResultTurn,
  hasCallCard,
  hasResultCard,
  presentToolCalls,
  presentToolResults,
} from "../dist/index.js";

const TOOLS = ["fs.read_file", "fs.list_dir", "fs.write_file", "fs.search", "shell.exec", "http.request"];

const THREE_CALLS =
  "<tool_calls>" +
  '<invoke name="fs_list_dir"><parameter name="path">C:\\Users\\me\\proj</parameter>' +
  '<parameter name="maxEntries" type="integer">200</parameter></invoke>' +
  '<invoke name="fs_list_dir"><parameter name="path">C:\\Users\\me</parameter>' +
  '<parameter name="maxEntries" type="integer">200</parameter></invoke>' +
  '<invoke name="fs_list_dir"><parameter name="path">C:\\</parameter>' +
  '<parameter name="maxEntries" type="integer">200</parameter></invoke>' +
  "</tool_calls>";

test("renders a tool call as a named card instead of raw XML", () => {
  const out = presentToolCalls(THREE_CALLS, TOOLS);

  assert.doesNotMatch(out, /<invoke/);
  assert.doesNotMatch(out, /<tool_calls>/);
  assert.equal(out.split(CALL_CARD_MARK).length - 1, 3);
  assert.match(out, /fs\.list_dir/);
  assert.match(out, /path: "C:\\\\Users\\\\me\\\\proj"/);
  assert.match(out, /maxEntries: 200/);
});

test("is idempotent: a rendered card survives a second pass", () => {
  const once = presentToolCalls(THREE_CALLS, TOOLS);
  assert.equal(presentToolCalls(once, TOOLS), once);
  assert.equal(hasCallCard(once), true);
});

test("keeps prose and unrelated XML that is not a call", () => {
  const text =
    '先看一下目录。<tool_calls><invoke name="fs_list_dir"><parameter name="path">C:\\tmp</parameter></invoke></tool_calls> 然后再说。';
  const out = presentToolCalls(text, TOOLS);

  assert.match(out, /先看一下目录。/);
  assert.match(out, /然后再说。/);
  assert.doesNotMatch(out, /<invoke/);

  // An unknown tool name is inert and must survive verbatim.
  const foreign = "示例：<span>hi</span>";
  assert.equal(presentToolCalls(foreign, TOOLS), foreign);
});

test("never relabels a call that lives inside a code fence", () => {
  const text = [
    "调用格式是：",
    "```xml",
    '<tool_calls><invoke name="fs_list_dir"><parameter name="path">C:\\tmp</parameter></invoke></tool_calls>',
    "```",
  ].join("\n");
  assert.equal(presentToolCalls(text, TOOLS), text);
});

test("renders a call with no parameters as a card", () => {
  // Under the wrapper dialect a malformed body is no longer the failure mode it
  // was under JSON — a missing parameter is simply an empty argument set — so the
  // card must still be honest about what was submitted.
  const out = presentToolCalls('<tool_calls><invoke name="fs_list_dir"></invoke></tool_calls>', TOOLS);
  assert.doesNotMatch(out, /<invoke/);
  assert.match(out, /fs\.list_dir/);
  assert.match(out, /\(无参数\)/);
});

test("leaves an unterminated invoke alone while it is still streaming", () => {
  // An unterminated invoke is a streaming state, not a call: the parser reports
  // it as incomplete and there is nothing to render yet.
  const text = '<tool_calls><invoke name="fs_list_dir"><parameter name="path">C:\\tmp';
  assert.equal(presentToolCalls(text, TOOLS), text);
});

const RESULT_TURN = [
  '<tool_result name="fs.list_dir" status="ok">',
  "     1\t.gitignore",
  "     2\tapps/",
  "     3\tpackages/",
  "</tool_result>",
  "",
  '<tool_result name="shell.exec" status="error">',
  "no workspace root is configured",
  "</tool_result>",
  "",
  "以上是本机工具的执行结果，请据此继续回答。",
].join("\n");

test("renders each tool result as a card, keeping the output visible", () => {
  const out = presentToolResults(RESULT_TURN);

  assert.doesNotMatch(out, /<tool_result/);
  assert.equal(out.split(RESULT_CARD_MARK).length - 1, 2);
  assert.match(out, /fs\.list_dir {2}执行结果/);
  assert.match(out, /shell\.exec {2}执行失败/);
  // The listing itself is the point of the card, so it must be readable.
  assert.match(out, /apps\//);
  // Numbered-result gutters are trimmed to the common indent.
  assert.match(out, /1\t\.gitignore/);
  // The bridge's own trailing line is dropped by the renderer, not the scrubber.
  assert.doesNotMatch(out, /以上是本机工具的执行结果/);
});

test("result cards are idempotent too", () => {
  const once = presentToolResults(RESULT_TURN);
  assert.equal(presentToolResults(once), once);
  assert.equal(hasResultCard(once), true);
});

test("elides a very long result instead of pasting a wall of text", () => {
  const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const out = presentToolResults(`<tool_result name="fs.read_file" status="ok">\n${body}\n</tool_result>`);

  assert.match(out, /line 0/);
  assert.match(out, /其余 \d+ 行省略/);
  assert.ok(out.length < 2500, `card was ${out.length} chars`);
});

test("leaves a message with no result blocks byte-identical", () => {
  const text = "只是一句话";
  assert.equal(presentToolResults(text), text);
});

test("the emitted native result turn round-trips into one card per result", () => {
  const turn = buildToolResultTurn(
    [
      { name: "fs.list_dir", text: "a.txt\nb.txt", isError: false },
      { name: "shell.exec", text: "boom", isError: true },
    ],
    "以上是本机工具的执行结果，请据此继续回答。",
  );

  // buildToolResultTurn uses the canonical fullwidth output markers so the
  // model reads the tool-output template it was trained on.
  assert.match(turn, /<｜tool▁outputs▁begin｜>/);
  assert.match(turn, /<｜tool▁output▁begin｜>a\.txt/);
  assert.match(turn, /<｜tool▁output▁begin｜>boom/);

  const rendered = presentToolResults(turn);
  assert.equal(rendered.split(RESULT_CARD_MARK).length - 1, 2);
  assert.doesNotMatch(rendered, /tool▁output/);

  // The ASCII-bar spelling from older bridge versions still renders too.
  const asciiTurn = `<|tool▁outputs▁begin|><|tool▁output▁begin|>legacy<|tool▁output▁end|><|tool▁outputs▁end|>\n以上是本机工具的执行结果，请据此继续回答。`;
  const renderedLegacy = presentToolResults(asciiTurn);
  assert.equal(renderedLegacy.split(RESULT_CARD_MARK).length - 1, 1);
  assert.doesNotMatch(renderedLegacy, /tool▁output/);
});


// The wrapper tags must disappear with the calls: leaving `<|tool▁calls▁begin|>`
// behind is exactly the leak the web page shows when a dialect is unhandled.
test("JSON-array dialect: cards replace the whole wrapper, no raw tags left", () => {
  const text =
    `我来帮你查看。\n<|tool▁calls▁begin|>[{"name":"fs_read_file","arguments":{"path":"C:\\\\a.txt"}}]<|tool▁calls▁end|>\n请稍等。`;
  const rendered = presentToolCalls(text, TOOLS);
  assert.match(rendered, /▸ fs\.read_file/);
  assert.doesNotMatch(rendered, /tool▁calls/);
  assert.match(rendered, /我来帮你查看。/);
  assert.match(rendered, /请稍等。/);
});

test("token-form native calls drop the wrapper tags too", () => {
  const text =
    `<|tool▁calls▁begin|><|tool▁call▁begin|>fs.read_file<|tool▁sep|>{"path":"C:/a"}<|tool▁call▁end|><|tool▁calls▁end|>`;
  const rendered = presentToolCalls(text, TOOLS);
  assert.match(rendered, /▸ fs\.read_file/);
  assert.doesNotMatch(rendered, /tool▁calls/);
});

test("JSON-array dialect: rendering is idempotent", () => {
  const text =
    `<|tool▁calls▁begin|>[{"name":"fs.list_dir","arguments":{"path":"C:/tmp"}}]<|tool▁calls▁end|>`;
  const once = presentToolCalls(text, TOOLS);
  assert.equal(presentToolCalls(once, TOOLS), once);
});
