/**
 * Tests for the prompt-injection tool protocol.
 *
 * The parser runs against live, partially-streamed model output that is never
 * quite well-formed, so these cases pin down the recovery behaviour the
 * streaming UI depends on.
 *
 * The dialect is the wrapper form below, and the two properties the rest of the
 * system leans on are (a) a call is only a call when its `name` resolves to a
 * real tool, and (b) parameter text is never reinterpreted — a Windows path must
 * survive verbatim, because the escaping burden is exactly what used to break
 * the previous dialect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INVOKE_CLOSE,
  INVOKE_OPEN,
  PARAMETER_CLOSE,
  PARAMETER_OPEN,
  TOOL_CALLS_CLOSE,
  TOOL_CALLS_OPEN,
  ToolCallStreamParser,
  buildReminder,
  buildSystemPrompt,
  extractJsonObject,
  formatToolResult,
  parseToolCalls,
  stripToolCalls,
  tagNameFor,
  NATIVE_TOOL_CALLS_OPEN,
  NATIVE_TOOL_CALLS_CLOSE,
  NATIVE_TOOL_CALL_OPEN,
  NATIVE_TOOL_CALL_CLOSE,
  NATIVE_TOOL_SEP,
} from "../dist/index.js";
import { BUILTIN_TOOLS } from "../dist/catalog.js";

const TOOLS = ["fs.read_file", "fs.list_dir", "fs.write_file", "fs.search", "shell.exec", "http.request"];

/** `<｜｜DSML｜｜ invoke name="…">` for `tool`. */
const invoke = (tool, attributes = "") => `${INVOKE_OPEN}"${tool}"${attributes}>`;
/** One `<｜｜DSML｜｜ parameter name="…">value</｜｜DSML｜｜ parameter>`. */
const parameter = (name, value, attributes = "") => `${PARAMETER_OPEN}"${name}"${attributes}>${value}${PARAMETER_CLOSE}`;

/** Builds one invoke inside a wrapper, from `[name, text, type?]` triples. */
function call(tool, parameters) {
  const inner = parameters
    .map(([name, value, type]) => {
      // `string="true"` is the dialect's own spelling; other types use `type`.
      const declared = type === "string" ? ' string="true"' : type ? ` type="${type}"` : "";
      return parameter(name, value, declared);
    })
    .join("");
  return `${TOOL_CALLS_OPEN}${invoke(tool)}${inner}${INVOKE_CLOSE}${TOOL_CALLS_CLOSE}`;
}

test("derives an underscore tag name from a dotted tool name", () => {
  assert.equal(tagNameFor("fs.read_file"), "fs_read_file");
  assert.equal(tagNameFor("shell.exec"), "shell_exec");
  assert.equal(tagNameFor("http.request"), "http_request");
});

test("repairs json_repair-style single quotes, comments, missing commas, and delimiters", () => {
  const text =
    `${NATIVE_TOOL_CALL_OPEN}fs_read_file${NATIVE_TOOL_SEP}` +
    "{'path': '/tmp/a.txt' // comment\n 'limit': 5" +
    `${NATIVE_TOOL_CALL_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/tmp/a.txt", limit: 5 });
});

test("repairs truncated arrays and trailing prose like json_repair", () => {
  const text =
    `${NATIVE_TOOL_CALL_OPEN}${NATIVE_TOOL_CALL_OPEN}fs_list_dir${NATIVE_TOOL_SEP}` +
    '{path:"/a", items:[1, 2, 3' +
    `${NATIVE_TOOL_CALL_CLOSE}${NATIVE_TOOL_CALLS_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 0); // malformed nested wrapper is not a call

  const direct = `${NATIVE_TOOL_CALL_OPEN}fs_list_dir${NATIVE_TOOL_SEP}{path:"/a", items:[1,2,3${NATIVE_TOOL_CALL_CLOSE}`;
  const repaired = parseToolCalls(direct, TOOLS);
  assert.equal(repaired.calls.length, 1);
  assert.deepEqual(repaired.calls[0].arguments, { path: "/a", items: [1, 2, 3] });
});

test("accepts DeepSeek native token-like tool calls with JSON arguments", () => {
  const text =
    NATIVE_TOOL_CALLS_OPEN +
    NATIVE_TOOL_CALL_OPEN +
    "fs_read_file" +
    NATIVE_TOOL_SEP +
    '{path: "/tmp/a.txt", limit: 5,}' +
    NATIVE_TOOL_CALL_CLOSE +
    NATIVE_TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/tmp/a.txt", limit: 5 });
  assert.equal(stripToolCalls(text, TOOLS), "");
});

test("repairs a native JSON call with an unescaped Windows path", () => {
  const text =
    NATIVE_TOOL_CALLS_OPEN +
    NATIVE_TOOL_CALL_OPEN +
    "fs_read_file" +
    NATIVE_TOOL_SEP +
    '{path: "C:\\z\\a.txt",}' +
    NATIVE_TOOL_CALL_CLOSE +
    NATIVE_TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].arguments.path, "C:\\z\\a.txt");
});

test("accepts native tool-call labels with ASCII/full-width and underscore variants", () => {
  const text =
    "<|tool_calls_begin|><|tool_call_begin|>fs_list_dir<|tool_sep|>{path:\"/a\",recursive:true}<|tool_call_end|><|tool_calls_end|>";
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/a", recursive: true });
});

test("accepts the native single-call fallback without the outer wrapper", () => {
  const text = `${NATIVE_TOOL_CALL_OPEN}fs_read_file${NATIVE_TOOL_SEP}{"path":"/a"}${NATIVE_TOOL_CALL_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].name, "fs.read_file");
  assert.deepEqual(outcome.calls[0].arguments, { path: "/a" });
});

test("accepts legacy function XML as a last-resort fallback", () => {
  const text = '<tool_call><function="fs_read_file">{"path":"/a"}</function></tool_call>';
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/a" });
});

test("does not execute unknown native or legacy calls", () => {
  const native = '<|tool_calls_begin|><|tool_call_begin|>rm_rf_everything<|tool_sep|>{path:"/"}<|tool_call_end|><|tool_calls_end|>';
  const legacy = '<tool_call><function="rm_rf_everything">{"path":"/"}</function></tool_call>';
  assert.equal(parseToolCalls(native, TOOLS).calls.length, 0);
  assert.equal(parseToolCalls(legacy, TOOLS).calls.length, 0);
});

test("parses a single well-formed call", () => {
  const text = call("fs_read_file", [["path", "C:\\tmp\\a.txt", "string"]]);
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.errors.length, 0);
  assert.equal(outcome.calls[0].name, "fs.read_file");
  // The escaping-bearing case: a Windows path arrives exactly as written.
  assert.equal(outcome.calls[0].arguments.path, "C:\\tmp\\a.txt");
});

test("accepts a dotted tool name as readily as the underscored one", () => {
  const text = call("fs.read_file", [["path", "/a"]]);
  assert.equal(parseToolCalls(text, TOOLS).calls[0].name, "fs.read_file");
});

test("parses several invokes from one wrapper, in order", () => {
  const text =
    TOOL_CALLS_OPEN +
    invoke("fs_list_dir") + parameter("path", "/a") + INVOKE_CLOSE +
    invoke("fs_read_file") + parameter("path", "/a/b") + INVOKE_CLOSE +
    TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.deepEqual(
    outcome.calls.map((call) => call.name),
    ["fs.list_dir", "fs.read_file"],
  );
  // The wrapper is consumed once, not once per call.
  assert.deepEqual(outcome.rewrites, [[0, text.length]]);
});

test("parses several calls emitted across separate wrappers", () => {
  const text =
    call("fs_list_dir", [["path", "/a"]]) + "\nsome chatter\n" + call("fs_read_file", [["path", "/a/b"]]);
  const outcome = parseToolCalls(text, TOOLS);
  assert.deepEqual(
    outcome.calls.map((c) => c.name),
    ["fs.list_dir", "fs.read_file"],
  );
  assert.equal(outcome.rewrites.length, 2);
});

test("tolerates attributes on the wrapper and invoke tags", () => {
  const text =
    '<｜｜DSML｜｜ calls id="1">' + invoke("fs_read_file", ' note="x"') + parameter("path", "/a") + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/a" });
});

test("honours a single-quoted name attribute", () => {
  const text =
    TOOL_CALLS_OPEN + "<｜｜DSML｜｜ invoke name='fs_read_file'><｜｜DSML｜｜ parameter name='path'>/a" + PARAMETER_CLOSE + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/a" });
});

test("still accepts the legacy <tool_calls><invoke> spelling", () => {
  // A model that drops the DSML prefix loses nothing: the tags are otherwise
  // identical, so the call executes and the wrapper is consumed the same way.
  const text = '<tool_calls><invoke name="fs_read_file"><parameter name="path">C:\\tmp\\a.txt</parameter></invoke></tool_calls>';
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].arguments.path, "C:\\tmp\\a.txt");
  assert.deepEqual(outcome.rewrites, [[0, text.length]]);
  assert.equal(stripToolCalls(text, TOOLS), "");
});

test("an invoke outside a wrapper still parses", () => {
  // The wrapper is what the prompt asks for, but losing it should cost the
  // model nothing: the call itself is unambiguous.
  const text = invoke("fs_read_file") + parameter("path", "/a") + INVOKE_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.rewrites, []);
});

test("coerces declared parameter types", () => {
  const text = call("fs_list_dir", [
    ["path", "/a"],
    ["recursive", "true", "boolean"],
    ["maxEntries", "200", "integer"],
  ]);
  assert.deepEqual(parseToolCalls(text, TOOLS).calls[0].arguments, {
    path: "/a",
    recursive: true,
    maxEntries: 200,
  });
});

test("coerces undeclared primitives but never a path", () => {
  const text = call("fs_list_dir", [
    ["path", "/a"],
    ["maxEntries", "200"],
    ["recursive", "false"],
  ]);
  assert.deepEqual(parseToolCalls(text, TOOLS).calls[0].arguments, {
    path: "/a",
    maxEntries: 200,
    recursive: false,
  });
});

test("keeps a numeric-looking value a string when the type says string", () => {
  // `fs.write_file` content is the case that matters: text that happens to look
  // like a number must not come back as one. The declared type is the only signal
  // that distinguishes it from a genuine `maxEntries: 200`.
  const text = call("fs_write_file", [
    ["path", "/a"],
    ["content", "12345", "string"],
  ]);
  assert.equal(parseToolCalls(text, TOOLS).calls[0].arguments.content, "12345");

  // Without the declaration the same text is read as the number it spells — the
  // price of accepting untyped parameters at all.
  const untyped = call("fs_write_file", [
    ["path", "/a"],
    ["content", "12345"],
  ]);
  assert.equal(parseToolCalls(untyped, TOOLS).calls[0].arguments.content, 12345);
});

test("preserves an unescaped backslash path", () => {
  // The defect that retired the JSON dialect: `{"path": "C:\tmp"}` is invalid
  // JSON and the whole call was dropped. Plain text has no such failure.
  const text = call("fs_read_file", [["path", "C:\\Users\\me\\a.txt"]]);
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].arguments.path, "C:\\Users\\me\\a.txt");
});

test("keeps surrounding whitespace out of a parameter value", () => {
  const text =
    TOOL_CALLS_OPEN + invoke("fs_read_file") + "\n  " + parameter("path", "\n  /a  \n  ") + "\n" + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  assert.equal(parseToolCalls(text, TOOLS).calls[0].arguments.path, "/a");
});

test("recovers a JSON-bodied invoke from the previous dialect", () => {
  // A model that still writes `{"path": …}` inside the wrapper is understood
  // rather than dropped; the wrapper only ever adds information.
  const text = TOOL_CALLS_OPEN + invoke("fs_read_file") + '{"path": "/a", "limit": 5}' + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.deepEqual(outcome.calls[0].arguments, { path: "/a", limit: 5 });
});

test("ignores calls whose names are not real tools", () => {
  // This is the security property: XML a user pastes in cannot execute.
  const text = call("rm_rf_everything", [["path", "/"]]);
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 0);
  assert.equal(outcome.errors.length, 0);
  // The wrapper is not consumed either: deleting text the parser never claimed
  // would swallow a page's own markup.
  assert.equal(outcome.rewrites.length, 0);
});

test("does not consume a wrapper that also holds an unknown invoke", () => {
  const text =
    TOOL_CALLS_OPEN +
    invoke("fs_list_dir") + parameter("path", "/a") + INVOKE_CLOSE +
    invoke("not_a_tool") + parameter("x", "1") + INVOKE_CLOSE +
    TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.rewrites, []);
});

test("an invoke with no parameters still parses", () => {
  const text = TOOL_CALLS_OPEN + invoke("fs.list_dir") + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, {});
});

test("flags a dangling invoke as incomplete", () => {
  const outcome = parseToolCalls("thinking... " + TOOL_CALLS_OPEN + invoke("fs_read_file") + PARAMETER_OPEN + '"path">/a', TOOLS);
  assert.equal(outcome.incomplete, true);
  assert.equal(outcome.calls.length, 0);
});

test("does not flag a completed call as incomplete", () => {
  const outcome = parseToolCalls(call("fs_list_dir", [["path", "/a"]]), TOOLS);
  assert.equal(outcome.incomplete, false);
});

test("recovers a call wrapped in a code fence anyway", () => {
  // The model is told not to fence, but the wrapper is self-delimiting, so a
  // fenced call is still found rather than silently dropped.
  const text = "Sure!\n```xml\n" + call("fs_list_dir", [["path", "/a"]]) + "\n```";
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].name, "fs.list_dir");
});

test("ignores unrelated fenced code blocks", () => {
  const text = "```js\nconst x = 1;\n```";
  assert.equal(parseToolCalls(text, TOOLS).calls.length, 0);
});

test("stripToolCalls removes the whole call and leaves prose", () => {
  const text = "Let me look.\n" + call("fs_list_dir", [["path", "/a"]]) + "\nDone.";
  const stripped = stripToolCalls(text, TOOLS);
  assert.ok(!stripped.includes("invoke"), stripped);
  assert.ok(!stripped.includes("DSML"), stripped);
  assert.ok(stripped.includes("Let me look."));
  assert.ok(stripped.includes("Done."));
});

test("stripToolCalls removes a wrapper holding an unknown invoke", () => {
  // The wrapper is the bridge's own syntax, never the page's, so a stray
  // invoke inside it is protocol noise rather than content.
  const text = TOOL_CALLS_OPEN + invoke("not_a_tool") + parameter("x", "1") + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  assert.equal(stripToolCalls(text, TOOLS), "");
});

test("stripToolCalls leaves unrelated markup intact", () => {
  const text = "Before <div>keep me</div> " + call("fs_list_dir", [["path", "/a"]]) + " after";
  const stripped = stripToolCalls(text, TOOLS);
  assert.ok(stripped.includes("<div>keep me</div>"), "unrelated markup must survive");
  assert.ok(!stripped.includes("fs_list_dir"));
});

test("extractJsonObject ignores braces inside string literals", () => {
  const found = extractJsonObject('{"a": "}{ not a brace", "b": 1}');
  assert.ok(found);
  assert.equal(found.json, '{"a": "}{ not a brace", "b": 1}');
});

test("extractJsonObject returns null while the object is still open", () => {
  assert.equal(extractJsonObject('{"a": "b"'), null);
});

test("stream parser emits each call exactly once, mid-stream", () => {
  const parser = new ToolCallStreamParser(TOOLS);
  const chunks = [
    "Let me check that for you.\n" + TOOL_CALLS_OPEN + "\n",
    invoke("fs_list_dir") + "\n" + PARAMETER_OPEN + '"path">',
    "/tmp" + PARAMETER_CLOSE + "\n" + INVOKE_CLOSE + "\n",
    TOOL_CALLS_CLOSE + "\n",
    "Now the second one.\n",
    call("fs_read_file", [["path", "/tmp/a"]]),
  ];

  const emitted = [];
  for (const chunk of chunks) {
    for (const call of parser.push(chunk)) emitted.push(call.name);
  }

  assert.deepEqual(emitted, ["fs.list_dir", "fs.read_file"]);
});

test("stream parser does not re-emit on repeated pushes", () => {
  const parser = new ToolCallStreamParser(TOOLS);
  parser.push(call("fs_list_dir", [["path", "/a"]]));
  assert.equal(parser.push("").length, 0);
  assert.equal(parser.calls.length, 1);
});

test("stream parser exposes visible text with calls removed", () => {
  const parser = new ToolCallStreamParser(TOOLS);
  parser.push("Hello " + call("fs_list_dir", [["path", "/a"]]) + " world");
  assert.ok(!parser.visibleText.includes("invoke"), parser.visibleText);
  assert.ok(parser.visibleText.includes("Hello"));
  assert.ok(parser.visibleText.includes("world"));
});

test("stream parser resets cleanly between conversations", () => {
  const parser = new ToolCallStreamParser(TOOLS);
  parser.push(call("fs_list_dir", [["path", "/a"]]));
  parser.reset();
  assert.equal(parser.calls.length, 0);
  assert.equal(parser.raw, "");
});

test("formatToolResult uses the native DeepSeek output markers", () => {
  const rendered = formatToolResult("fs.read_file", {
    content: [{ type: "text", text: "line one" }],
    isError: false,
  });
  assert.ok(rendered.startsWith("<｜tool▁output▁begin｜>"));
  assert.ok(rendered.endsWith("<｜tool▁output▁end｜>"));
  assert.ok(rendered.includes("line one"));
});

test("formatToolResult preserves truncation text", () => {
  const rendered = formatToolResult("shell.exec", {
    content: [{ type: "text", text: "boom" }],
    isError: true,
    truncated: true,
  });
  assert.ok(rendered.includes("boom"));
  assert.ok(rendered.includes("truncated"));
});

test("system prompt teaches the DeepSeek native JSON-array dialect", () => {
  const prompt = buildSystemPrompt({ tools: BUILTIN_TOOLS, locale: "en" });
  assert.ok(prompt.includes(NATIVE_TOOL_CALLS_OPEN));
  assert.ok(prompt.includes(NATIVE_TOOL_CALLS_CLOSE));
  // The contract now teaches a JSON array inside the wrapper, not the
  // per-call token form: that is the dialect the current web model emits.
  assert.ok(prompt.includes('"name"'));
  assert.ok(prompt.includes('"arguments"'));
  assert.ok(prompt.includes("must be valid JSON"));
  assert.ok(prompt.includes("Markdown fences"));
  assert.ok(prompt.includes("only one tool-call block per answer"));
});

test("the reminder is disabled because the current format uses one System block", () => {
  assert.equal(buildReminder(BUILTIN_TOOLS, "en"), "");
  assert.equal(buildReminder(BUILTIN_TOOLS, "zh"), "");
});

test("the native contract example actually parses against the catalogue", () => {
  for (const locale of ["zh", "en"]) {
    const prompt = buildSystemPrompt({ tools: BUILTIN_TOOLS, locale });
    const start = prompt.indexOf(NATIVE_TOOL_CALLS_OPEN);
    const end = prompt.indexOf(NATIVE_TOOL_CALLS_CLOSE, start) + NATIVE_TOOL_CALLS_CLOSE.length;
    const example = prompt.slice(start, end);
    const outcome = parseToolCalls(example, BUILTIN_TOOLS.map((tool) => tool.name));
    assert.equal(outcome.calls.length, 1, `${locale} example did not parse: ${example}`);
    assert.equal(outcome.calls[0].name, BUILTIN_TOOLS[0].name);
  }
});

test('string="true" keeps a numeric-looking value a string', () => {
  const text = TOOL_CALLS_OPEN + invoke("fs_write_file") + parameter("path", "/a") + parameter("content", "12345", ' string="true"') + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  assert.equal(parseToolCalls(text, TOOLS).calls[0].arguments.content, "12345");
});

test("system prompt renders required and optional arguments distinctly", () => {
  const prompt = buildSystemPrompt({ tools: [BUILTIN_TOOLS[0]], locale: "en" });
  assert.ok(prompt.includes("path: string"));
  assert.ok(prompt.includes("limit?: integer"));
});

test('string="true" keeps a numeric-looking value a string', () => {
  const text = TOOL_CALLS_OPEN + invoke("fs_write_file") + parameter("path", "/a") + parameter("content", "12345", ' string="true"') + INVOKE_CLOSE + TOOL_CALLS_CLOSE;
  assert.equal(parseToolCalls(text, TOOLS).calls[0].arguments.content, "12345");
});

test("system prompt renders required and optional arguments distinctly", () => {
  const prompt = buildSystemPrompt({ tools: [BUILTIN_TOOLS[0]], locale: "en" });
  // `path` is required, so it carries no `?`; `limit` is optional and does.
  assert.ok(prompt.includes("path: string"));
  assert.ok(prompt.includes("limit?: integer"));
});


// ---------------------------------------------------------------------------
// JSON-array dialect: the wrapper form the current web model emits
// (ds-free-api drives it with `<|tool▁calls▁begin|>[{"name":…,"arguments":…}]<|tool▁calls▁end|>`)
// ---------------------------------------------------------------------------

const NATIVE_ARRAY_OPEN = "<|tool▁calls▁begin|>";
const NATIVE_ARRAY_CLOSE = "<|tool▁calls▁end|>";

test("JSON-array dialect: a single call parses with its arguments", () => {
  const text =
    `${NATIVE_ARRAY_OPEN}[{"name":"fs_read_file","arguments":{"path":"C:\\\\Users\\\\me\\\\a.txt","limit":200}}]${NATIVE_ARRAY_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].name, "fs.read_file");
  assert.equal(outcome.calls[0].arguments.path, "C:\\Users\\me\\a.txt");
  assert.equal(outcome.calls[0].arguments.limit, 200);
  assert.equal(outcome.rewrites.length, 1, "the whole wrapper is a rewrite target");
});

test("JSON-array dialect: multiple calls parse in array order", () => {
  const text =
    `${NATIVE_ARRAY_OPEN}[{"name":"fs.list_dir","arguments":{"path":"C:/tmp"}},{"name":"fs.read_file","arguments":{"path":"C:/tmp/a.txt"}}]${NATIVE_ARRAY_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.deepEqual(
    outcome.calls.map((call) => call.name),
    ["fs.list_dir", "fs.read_file"],
  );
  assert.equal(outcome.rewrites.length, 1);
});

test("JSON-array dialect: fullwidth-bar spelling parses too", () => {
  const text =
    "<｜tool▁calls▁begin｜>[{\"name\":\"fs_search\",\"arguments\":{\"path\":\"C:/tmp\"}}]<｜tool▁calls▁end｜>";
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].name, "fs.search");
});

test("JSON-array dialect: a stringified arguments object is decoded", () => {
  const text =
    `${NATIVE_ARRAY_OPEN}[{"name":"shell_exec","arguments":"{\\"command\\":\\"dir\\"}"}]${NATIVE_ARRAY_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.deepEqual(outcome.calls[0].arguments, { command: "dir" });
});

test("JSON-array dialect: an unknown tool name is inert", () => {
  const text =
    `${NATIVE_ARRAY_OPEN}[{"name":"rm_rf_everything","arguments":{"path":"/"}}]${NATIVE_ARRAY_CLOSE}`;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 0);
  assert.equal(outcome.rewrites.length, 0);
});

test("JSON-array dialect: a wrapper inside a code fence is not a call", () => {
  const text =
    `示例：\n\`\`\`json\n${NATIVE_ARRAY_OPEN}[{"name":"fs.read_file","arguments":{"path":"/a"}}]${NATIVE_ARRAY_CLOSE}\n\`\`\``;
  const outcome = parseToolCalls(text, TOOLS);
  assert.equal(outcome.calls.length, 0);
});

test("JSON-array dialect: stripToolCalls removes the wrapper wholesale", () => {
  const text =
    `${NATIVE_ARRAY_OPEN}[{"name":"fs.list_dir","arguments":{"path":"C:/tmp"}}]${NATIVE_ARRAY_CLOSE}`;
  const stripped = stripToolCalls(text, TOOLS);
  assert.doesNotMatch(stripped, /tool▁calls/);
  assert.equal(stripped.trim(), "");
});

test("JSON-array dialect: an open wrapper with a visible name keeps buffering", () => {
  const partial = `${NATIVE_ARRAY_OPEN}[{"name":"fs.read_file","arguments":{"path":"C:/tmp/a`;
  assert.equal(parseToolCalls(partial, TOOLS).incomplete, true);
});

test("JSON-array dialect: streamed one token at a time emits the call once", () => {
  const parser = new ToolCallStreamParser(TOOLS);
  const full =
    `${NATIVE_ARRAY_OPEN}[{"name":"fs.read_file","arguments":{"path":"C:/a"}}]${NATIVE_ARRAY_CLOSE}`;
  let emitted = 0;
  for (const ch of full) emitted += parser.push(ch).length;
  assert.equal(emitted, 1);
  assert.equal(parser.calls.length, 1);
});
