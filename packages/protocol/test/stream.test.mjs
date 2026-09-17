/**
 * Tests for the DeepSeek SSE patch-protocol decoder.
 *
 * Every case here corresponds to a documented trap in the upstream stream:
 * shared THINK/RESPONSE patch paths, `FINISHED` not ending the stream, and two
 * coexisting fragment formats.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AnswerAccumulator, DeepSeekStreamDecoder } from "../dist/index.js";

/** Frames a payload as an SSE `data:` event. */
function frame(payload, eventName) {
  const prefix = eventName ? `event: ${eventName}\n` : "";
  return `${prefix}data: ${JSON.stringify(payload)}\n\n`;
}

test("decodes a fragment-array append as response text", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(
    frame({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "你好" }] }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "你好");
  assert.equal(events[0].fragment, "response");
});

test("decodes a THINK fragment as reasoning, not answer", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(
    frame({ p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "let me think" }] }),
  );
  assert.equal(events[0].fragment, "think");
  assert.equal(events[0].text, "let me think");
});

test("a bare append attaches to the currently-open fragment", () => {
  // This is the central trap: a bare `{"v":"…"}` inherits whichever fragment
  // was opened last, so reasoning does not leak into the answer.
  const decoder = new DeepSeekStreamDecoder();
  decoder.push(frame({ p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "hmm" }] }));

  const events = decoder.push(frame({ v: " more thinking" }));
  assert.equal(events[0].fragment, "think");
  assert.equal(events[0].text, " more thinking");
});

test("a bare append after a RESPONSE fragment goes to the answer", () => {
  const decoder = new DeepSeekStreamDecoder();
  decoder.push(frame({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "Hello" }] }));
  const events = decoder.push(frame({ v: " world" }));
  assert.equal(events[0].fragment, "response");
});

test("the accumulator keeps reasoning out of the answer channel", () => {
  const decoder = new DeepSeekStreamDecoder();
  const accumulator = new AnswerAccumulator();

  const chunks = [
    frame({ p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "The user wants " }] }),
    frame({ v: "a file listing." }),
    frame({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "Here you go." }] }),
  ];
  for (const chunk of chunks) {
    for (const event of decoder.push(chunk)) accumulator.apply(event);
  }

  assert.equal(accumulator.thinking, "The user wants a file listing.");
  assert.equal(accumulator.answer, "Here you go.");
  // A tool call must never be searched for in reasoning.
  assert.ok(!accumulator.toolCallScope.includes("The user wants"));
});

test("decodes the legacy path-driven format", () => {
  const decoder = new DeepSeekStreamDecoder();
  const think = decoder.push(frame({ p: "response/thinking_content", o: "APPEND", v: "reasoning" }));
  assert.equal(think[0].fragment, "think");

  const answer = decoder.push(frame({ p: "response/content", o: "APPEND", v: "answer" }));
  assert.equal(answer[0].fragment, "response");
});

test("a path-driven append also updates the open fragment", () => {
  const decoder = new DeepSeekStreamDecoder();
  decoder.push(frame({ p: "response/thinking_content", o: "APPEND", v: "reasoning" }));
  const events = decoder.push(frame({ v: " continued" }));
  assert.equal(events[0].fragment, "think");
});

test("marks completion on response/status FINISHED", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(frame({ p: "response/status", v: "FINISHED" }));
  assert.equal(events[0].finished, true);
  assert.equal(decoder.finished, true);
});

test("marks completion on a BATCH quasi_status FINISHED", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(
    frame({ p: "response", o: "BATCH", v: [{ p: "quasi_status", v: "FINISHED" }] }),
  );
  assert.ok(events.some((event) => event.finished));
});

test("marks completion on a bare [DONE] sentinel", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push("data: [DONE]\n\n");
  assert.equal(events[0].finished, true);
});

test("keeps decoding search results that arrive after FINISHED", () => {
  // Upstream keeps sending after FINISHED when search is enabled, so the
  // reader must not treat FINISHED as end-of-stream.
  const decoder = new DeepSeekStreamDecoder();
  decoder.push(frame({ p: "response/status", v: "FINISHED" }));

  const events = decoder.push(frame({ p: "response/search_results", v: [{ title: "x" }] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].searchResults.length, 1);
});

test("surfaces an in-band error event", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(frame({ type: "error", content: "rate limited" }));
  assert.equal(events[0].error, "rate limited");
});

test("ignores metadata frames that carry no text", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(frame({ v: { response: { model: "x" } } }));
  assert.equal(events.length, 0);
});

test("ignores SSE comments and keep-alives", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(": keep-alive\n\n");
  assert.equal(events.length, 0);
});

test("tolerates a non-JSON data frame", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push("data: not json at all\n\n");
  assert.equal(events.length, 0);
});

test("reassembles a frame split across chunks", () => {
  const decoder = new DeepSeekStreamDecoder();
  const payload = frame({ p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "hi" }] });
  const cut = Math.floor(payload.length / 2);

  const first = decoder.push(payload.slice(0, cut));
  assert.equal(first.length, 0, "a partial frame must not emit");

  const second = decoder.push(payload.slice(cut));
  assert.equal(second.length, 1);
  assert.equal(second[0].text, "hi");
});

test("handles CRLF frame separators", () => {
  const decoder = new DeepSeekStreamDecoder();
  const payload = `data: ${JSON.stringify({ v: "hello" })}\r\n\r\n`;
  const events = decoder.push(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "hello");
});

test("decodes a batch of mixed fragments", () => {
  const decoder = new DeepSeekStreamDecoder();
  const events = decoder.push(
    frame({
      p: "response",
      o: "BATCH",
      v: [
        { p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "A" }] },
        { p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "B" }] },
      ],
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "AB");
  assert.equal(events[0].fragment, "response");
});

test("resets decoder state between conversations", () => {
  const decoder = new DeepSeekStreamDecoder();
  decoder.push(frame({ p: "response/status", v: "FINISHED" }));
  assert.equal(decoder.finished, true);

  decoder.reset();
  assert.equal(decoder.finished, false);
  assert.equal(decoder.pending, "");
});
