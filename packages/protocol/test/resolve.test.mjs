/**
 * Tests for tool-name resolution and bare-JSON envelope recovery.
 *
 * Both features trade strictness for recall, so the cases that matter most are
 * the ones that must still be *refused*: a near-miss that could run the wrong
 * tool is worse than a dropped call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReminder,
  parseEnvelopeCall,
  parseToolCalls,
  resolveToolName,
  similarity,
  stripToolCalls,
} from "../dist/index.js";
import { BUILTIN_TOOLS } from "../dist/catalog.js";

const TOOLS = ["fs.read_file", "fs.list_dir", "fs.write_file", "fs.search", "shell.exec", "http.request"];

test("resolves an exact canonical name", () => {
  assert.equal(resolveToolName("fs.read_file", TOOLS), "fs.read_file");
});

test("resolves an exact tag name", () => {
  assert.equal(resolveToolName("fs_read_file", TOOLS), "fs.read_file");
});

test("resolves a case-insensitive name", () => {
  assert.equal(resolveToolName("FS_READ_FILE", TOOLS), "fs.read_file");
});

test("recovers a single-character typo", () => {
  // `fs_readfile` is one deletion away from `fs_read_file`.
  assert.equal(resolveToolName("fs_readfile", TOOLS), "fs.read_file");
});

test("refuses a name that is not close to any tool", () => {
  assert.equal(resolveToolName("rm_rf_everything", TOOLS), null);
  assert.equal(resolveToolName("div", TOOLS), null);
  assert.equal(resolveToolName("", TOOLS), null);
});

test("does not confuse read with write", () => {
  // These are the two names whose confusion would be destructive, so they must
  // never resolve to each other.
  assert.equal(resolveToolName("fs_read_file", TOOLS), "fs.read_file");
  assert.equal(resolveToolName("fs_write_file", TOOLS), "fs.write_file");
  assert.equal(resolveToolName("fs_readfile", TOOLS), "fs.read_file");
  assert.equal(resolveToolName("fs_writefile", TOOLS), "fs.write_file");

  // The two names sit below the acceptance threshold from each other, so a
  // typo cannot silently cross the read/write boundary.
  assert.ok(similarity("fs_read_file", "fs_write_file") < 0.72);
});

test("a near-miss resolves to its nearest tool, preferring the safer one", () => {
  // One character from `read`, three from `write` — so it resolves to `read`,
  // which is also the non-destructive choice.
  assert.equal(resolveToolName("fs_wread_file", TOOLS), "fs.read_file");
});

test("refuses a genuine tie between two candidates", () => {
  // `aa_bc` is exactly one edit from both `aa_bb` and `aa_cc`, so neither is
  // nearest and the resolver must decline rather than pick arbitrarily.
  const tied = ["aa.bb", "aa.cc"];
  assert.equal(similarity("aa_bc", "aa_bb"), similarity("aa_bc", "aa_cc"));
  assert.equal(resolveToolName("aa_bc", tied), null);
});

test("resolves when one candidate is clearly nearest", () => {
  const candidates = ["shell.exec", "shell.execute"];
  assert.equal(resolveToolName("shell.exec", candidates), "shell.exec");
  assert.equal(resolveToolName("shell.execute", candidates), "shell.execute");
});

test("similarity is symmetric and bounded", () => {
  assert.equal(similarity("abc", "abc"), 1);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abc", ""), 0);
  assert.equal(similarity("abc", "abd"), similarity("abd", "abc"));
  assert.ok(similarity("abc", "abd") > 0.6 && similarity("abc", "abd") < 1);
});

test("a typo'd tool name is still executed as the intended tool", () => {
  const outcome = parseToolCalls('<tool_calls><invoke name="fs_listdir"><parameter name="path">/a</parameter></invoke></tool_calls>', TOOLS);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].name, "fs.list_dir");
});

test("stray markup is inert, not reported as an error", () => {
  const outcome = parseToolCalls("<div>hello</div><span>world</span>", TOOLS);
  assert.equal(outcome.calls.length, 0);
  assert.equal(outcome.errors.length, 0);
  assert.equal(outcome.incomplete, false);
});

test("unclosed non-tool markup does not look like a pending call", () => {
  // A page-level tag must not make the stream parser wait forever.
  assert.equal(parseToolCalls("<div class='x'>", TOOLS).incomplete, false);
  assert.equal(parseToolCalls('<invoke name="not_a_tool">', TOOLS).incomplete, false);
});

test("an unclosed real invoke does look pending", () => {
  assert.equal(parseToolCalls('<invoke name="fs_read_file"><parameter name="path">/a', TOOLS).incomplete, true);
});

test("stripToolCalls leaves unrelated markup intact", () => {
  const text =
    'Before <div>keep me</div> <tool_calls><invoke name="fs_list_dir"><parameter name="path">/a</parameter></invoke></tool_calls> after';
  const stripped = stripToolCalls(text, TOOLS);
  assert.ok(stripped.includes("<div>keep me</div>"), "unrelated markup must survive");
  assert.ok(!stripped.includes("fs_list_dir"));
});

test("recovers a call from a recognised bare-JSON envelope", () => {
  const text = 'Let me look.\n```json\n{"tool": "fs.list_dir", "arguments": {"path": "/a"}}\n```';
  const recovered = parseEnvelopeCall(text, TOOLS);
  assert.ok(recovered);
  assert.equal(recovered.name, "fs.list_dir");
  assert.deepEqual(recovered.arguments, { path: "/a" });
});

test("accepts `args` and `parameters` as argument containers", () => {
  assert.equal(
    parseEnvelopeCall('```json\n{"name":"fs.list_dir","args":{"path":"/a"}}\n```', TOOLS)?.name,
    "fs.list_dir",
  );
  assert.equal(
    parseEnvelopeCall('```json\n{"tool_name":"fs.search","parameters":{"path":"/a","pattern":"x"}}\n```', TOOLS)?.name,
    "fs.search",
  );
});

test("refuses an envelope naming an unknown tool", () => {
  const text = '```json\n{"tool": "delete_everything", "arguments": {}}\n```';
  assert.equal(parseEnvelopeCall(text, TOOLS), null);
});

test("refuses an envelope with extra unrelated keys", () => {
  // An object with extra keys is prose *about* a call, not a call.
  const text = '```json\n{"tool":"fs.list_dir","arguments":{"path":"/a"},"note":"example"}\n```';
  assert.equal(parseEnvelopeCall(text, TOOLS), null);
});

test("refuses a bare JSON object that is not a recognised envelope", () => {
  const text = '```json\n{"path": "/a", "recursive": true}\n```';
  assert.equal(parseEnvelopeCall(text, TOOLS), null);
});

test("refuses an envelope whose arguments are not an object", () => {
  const text = '```json\n{"tool":"fs.list_dir","arguments":[1,2]}\n```';
  assert.equal(parseEnvelopeCall(text, TOOLS), null);
});

test("bare JSON is not promoted to a call by the main parser", () => {
  // The main parser must ignore it; recovery is a separate, opt-in step.
  const text = '```json\n{"tool": "fs.list_dir", "arguments": {"path": "/a"}}\n```';
  assert.equal(parseToolCalls(text, TOOLS).calls.length, 0);
});

test("the reminder is empty under native ChatML alignment", () => {
  assert.equal(buildReminder(BUILTIN_TOOLS, "en"), "");
});

test("the reminder is empty when no tools are available", () => {
  assert.equal(buildReminder([], "en"), "");
});
