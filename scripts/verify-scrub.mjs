#!/usr/bin/env node
/**
 * Verifies the scrubber against text captured from the **live** page.
 *
 * Unit tests use synthetic strings; this one feeds the real thing — the exact
 * contract the extension injects, the real `<tool_result>` block format, and the
 * real Chinese footer observed on chat.deepseek.com. It also reconstructs a user
 * bubble the way the page actually builds it (contract + user text + reminder in
 * a *single* text node), which is the constraint the whole design exists to
 * satisfy.
 *
 * Usage: node scripts/verify-scrub.mjs
 */

import assert from "node:assert/strict";

import { BUILTIN_TOOLS } from "../packages/protocol/dist/catalog.js";
import {
  buildReminder,
  buildSystemPrompt,
  findInjectedRanges,
  findToolTagRanges,
  parseToolCalls,
  scrubInjectedText,
  stripToolCalls,
} from "../packages/protocol/dist/index.js";

const tools = BUILTIN_TOOLS;
const systemPrompt = buildSystemPrompt({ tools, locale: "zh" });
const reminder = buildReminder(tools, "zh");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
    if (detail !== undefined) console.log(`       ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

// --- 1. The real user bubble: contract + question + reminder, one text node ----

console.log("\n[1] user bubble (contract + question + reminder)");
const userQuestion = "帮我看看 C:\\Users\\MuWinds\\Documents\\Coding Project\\country-cloud 里有什么";
const bubble = [systemPrompt, "", "---", "", userQuestion, "", "---", "", reminder].join("\n");

const cleaned = scrubInjectedText(bubble, { systemPrompt, reminder });
check("leaves exactly the user's question", cleaned === userQuestion, cleaned);
check("contract is gone", !cleaned.includes("严格遵守以下规则"));
check("reminder is gone", !cleaned.includes("提醒：如需使用本机工具"));
check("no stray separators", !/^---$/m.test(cleaned), cleaned);

// --- 2. The real tool-result turn, exactly as the main-world script formats it -

console.log("\n[2] tool-result turn");
const toolResultTurn = [
  '<tool_result name="fs.read_file" status="ok">',
  "C:\\Users\\MuWinds\\Desktop\\dlb-test-workspace\\notes.txt (3 lines total, showing 1-3)",
  "     1\tProject: Local Tool Bridge",
  "     2\tStatus: end-to-end test",
  "     3\tSecret token: ZEBRA-7741",
  "</tool_result>",
  "",
  "以上是本机工具的执行结果，请据此继续回答。",
].join("\n");

const cleanedResult = scrubInjectedText(toolResultTurn, { systemPrompt, reminder });
check("tool_result turn scrubs to empty", cleanedResult.trim() === "", cleanedResult);

// --- 3. A reasoning tag: inert, but should not be shown ----------------------

console.log("\n[3] reasoning call");
// Real shape observed on the page: the call is the whole text node.
const reasoning = '用户想让我列出目录内容。路径包含空格，需要转义。让我递归列出。';
const reasoningWithTag =
  reasoning +
  '<tool_calls><invoke name="fs_list_dir"><parameter name="path">C:\\Users\\MuWinds\\Documents\\Coding Project\\country-cloud</parameter><parameter name="recursive" type="boolean">true</parameter></invoke></tool_calls>';
const toolNames = tools.map((tool) => tool.name);
const tagRanges = findToolTagRanges(reasoningWithTag, toolNames);

check("finds the reasoning call", tagRanges.length === 1, tagRanges);
check(
  "removing it leaves the reasoning prose, and no wrapper shell",
  reasoningWithTag.slice(0, tagRanges[0][0]) + reasoningWithTag.slice(tagRanges[0][1]) === reasoning,
);
check("known tool names drive it", findToolTagRanges(reasoningWithTag, ["other.tool"]).length === 0);

// --- 3b. A real call parses with its unescaped Windows path intact -----------

console.log("\n[3b] wrapper call parses");
const liveShape =
  '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="shell_exec">\n<｜｜DSML｜｜ parameter name="command" string="true">python scripts/dlb-restyle.py</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="cwd" string="true">C:\\Users\\MuWinds\\Documents\\Coding Project\\local-tool-bridge</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const parsed = parseToolCalls(liveShape, toolNames);
check("one call parsed", parsed.calls.length === 1, parsed.calls.map((c) => c.name));
check("tool name resolved", parsed.calls[0]?.name === "shell.exec", parsed.calls[0]?.name);
check(
  "path survived verbatim",
  parsed.calls[0]?.arguments.cwd === "C:\\Users\\MuWinds\\Documents\\Coding Project\\local-tool-bridge",
  parsed.calls[0]?.arguments,
);
check("wrapper is consumed whole", parsed.rewrites.length === 1 && parsed.rewrites[0][0] === 0, parsed.rewrites);
check("visible text drops the whole call", stripToolCalls(liveShape, toolNames) === "", stripToolCalls(liveShape, toolNames));

// --- 4. The user's own text must survive ------------------------------------

console.log("\n[4] user text is never over-deleted");
const userTexts = [
  "只是一句普通的话",
  "- 第一项\n- 第二项",
  "我的问题\n\n---\n\n补充说明",
  "示例：<span>hello</span> 和 <div>world</div>",
  "看看这个 XML：<note>hi</note>",
];
for (const text of userTexts) {
  const out = scrubInjectedText(text, { systemPrompt, reminder });
  check(`preserved: ${JSON.stringify(text.slice(0, 30))}`, out === text, out);
}

// --- 5. Offsets must land where the DOM layer expects ------------------------

console.log("\n[5] offsets index the original string");
const ranges = findInjectedRanges(bubble, { systemPrompt, reminder });
const byOffsets = ranges
  .slice()
  .sort((a, b) => b[0] - a[0])
  .reduce((text, [start, end]) => text.slice(0, start) + text.slice(end), bubble);
check("deleting by offset matches", byOffsets.trim() === userQuestion, byOffsets.trim());
check("ranges are sorted and disjoint",
  ranges.every(([start, end], i) => end > start && (i === 0 || start >= ranges[i - 1][1])),
  ranges);

// --- 6. The real contract length, to confirm prefix matching is not enough ---

console.log("\n[6] sanity on real sizes");
console.log(`  info contract length: ${systemPrompt.length} chars`);
console.log(`  info reminder length: ${reminder.length} chars`);
console.log(`  info real bubble length: ${bubble.length} chars`);
check("contract is large enough to justify prefix prefilter", systemPrompt.length > 500);

console.log(failures === 0 ? "\nRESULT: all live-text checks passed." : `\nRESULT: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
