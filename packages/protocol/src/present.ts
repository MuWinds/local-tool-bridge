/**
 * Turning the bridge's own wire syntax into something readable in the transcript.
 *
 * ## The problem this solves
 *
 * Tool calls are prompt-injected text, not native function calls (see
 * [`prompt.ts`](./prompt.ts) for why). The web app renders back an assistant
 * answer verbatim, so a turn that asked for three directories is *literally* this
 * on screen:
 *
 * ```text
 * <fs_list_dir>{"path": "C:\\Users\\me", "maxEntries": 200}</fs_list_dir>
 * <fs_list_dir>{"path": "C:\\", "maxEntries": 200}</fs_list_dir>
 * ```
 *
 * and a tool-result turn, being an injected user message, is the same thing for
 * `<tool_result …>` blocks. Both are protocol noise that happens to be visible to
 * a human.
 *
 * ## Why the output is plain text and not DOM
 *
 * The transcript is a React-owned virtual list. Rewriting a text node's *content*
 * is invisible to React (this is what [`scrub.ts`](./scrub.ts) already relies on);
 * replacing text with elements is not — React tracks text nodes as positional
 * child markers, so swapping one for an element makes the next render throw
 * (`insertBefore` on a node React no longer finds) and leaves orphaned DOM behind.
 *
 * So the transform here is a **string transform**: the card is spelled out as
 * text and dressed up with CSS by the content script. The tool/result data stays
 * fully visible; it just stops looking like a protocol leak.
 *
 * ## Idempotence
 *
 * The transform is re-applied on every DOM mutation, so it must be stable: the
 * output contains no `<tool…>` tags, which means a second pass is a no-op. That
 * property is asserted in `test/present.test.mjs`.
 */

import {
  INJECTED_RESULT_FOOTERS,
  parseToolCalls,
  stripToolCalls,
  TOOL_RESULT_CLOSE,
  type ParsedToolCall,
} from "./prompt.js";

/** Header glyph of a rendered call card. Absence of it means "not yet rendered". */
export const CALL_CARD_MARK = "▸";
/** Header glyph of a rendered result card. */
export const RESULT_CARD_MARK = "◂";
/** Box-drawing prefix on every line of a card body. */
export const CARD_RULE = "│";

/** Longest body line kept verbatim before it is elided. */
const MAX_LINE_CHARS = 200;
/** Body lines kept per result block, before a truncation notice. */
const MAX_BODY_LINES = 24;
/** Total characters of a whole rendered card, as a backstop. */
const MAX_CARD_CHARS = 4000;

/** A fenced code block: backticks or tildes, up to three spaces of indent. */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/m;

/** Half-open `[start, end)` character range. */
type Range = [number, number];

/**
 * Character ranges covered by fenced code blocks.
 *
 * A tag inside a fence is markdown the model is *showing*, not a call; the host
 * does not execute it (the parser refuses fenced envelopes) and the transcript
 * must not relabel it as one.
 */
function fencedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const lines = text.split("\n");

  let openFence: string | null = null;
  let openFrom = 0;
  let offset = 0;

  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line);
    if (match) {
      const marker = match[1]!;
      if (openFence === null) {
        openFence = marker;
        openFrom = offset;
      } else if (marker[0] === openFence[0] && marker.length >= openFence.length) {
        ranges.push([openFrom, offset + line.length]);
        openFence = null;
      }
    }
    offset += line.length + 1;
  }

  // An unterminated fence runs to the end of the text.
  if (openFence !== null) ranges.push([openFrom, text.length]);
  return ranges;
}

/** True when `offset` falls inside one of `ranges`. */
function inRanges(offset: number, ranges: readonly Range[]): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/** Renders one argument value compactly, so a one-line call stays one line. */
function renderValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // A cyclic or otherwise unserialisable value is still worth showing.
    text = String(value);
  }
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

/** Renders parsed arguments as `key: value` pairs, joined for a single line. */
function renderArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "(无参数)";
  if (keys.length <= 3) return keys.map((key) => `${key}: ${renderValue(args[key])}`).join("  ");
  return keys.map((key) => `  ${key}: ${renderValue(args[key])}`).join("\n");
}

/**
 * Formats a tool result body for display.
 *
 * The body is host output — often a listing or a file — so it keeps its line
 * structure, with the common indentation stripped and long lines elided. The
 * elision is presentational only: the model still received the full text.
 */
function renderBody(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");

  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const common = indents.length > 0 ? Math.min(...indents) : 0;

  const capped = lines.slice(0, MAX_BODY_LINES).map((line) => {
    const trimmed = line.slice(common).replace(/\s+$/, "");
    return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS - 1)}…` : trimmed;
  });

  if (lines.length > MAX_BODY_LINES) {
    capped.push(`… 其余 ${lines.length - MAX_BODY_LINES} 行省略（模型仍收到了完整结果）`);
  }
  return capped.join("\n");
}

/** Assembles a card from a header and a body, indenting every body line. */
function card(header: string, body: string): string {
  const lines = body.length > 0 ? body.split("\n") : [];
  const rendered = [`${header}`, ...lines.map((line) => (line.length > 0 ? `${CARD_RULE} ${line}` : CARD_RULE))];
  const text = rendered.join("\n");
  return text.length > MAX_CARD_CHARS ? `${text.slice(0, MAX_CARD_CHARS)}\n${CARD_RULE} …` : text;
}

/** Renders one parsed call as a card. */
function renderCall(call: ParsedToolCall): string {
  return card(`${CALL_CARD_MARK} ${call.name}  已提交本机执行`, renderArguments(call.arguments));
}

/** One parsed `<tool_result>` block. */
interface ParsedResult {
  name: string;
  status: string;
  body: string;
  start: number;
  end: number;
}

/**
 * Matches a `<tool_result …>…</tool_result>` block and captures its inner text.
 *
 * Exported because the scrubber needs the identical definition to *find* these
 * blocks; a second copy is the kind of drift that makes a renderer disagree with
 * its own scrubber.
 */
export const RESULT_BLOCK_PATTERN = /<tool_result\b([^>]*)>([\s\S]*?)<\/tool_result\s*>/g;
/** Native DeepSeek output block, both tokeniser spellings:
 * `<|tool▁output▁begin|>…<|tool▁output▁end|>` (ASCII bars, emitted by some
 * versions) and `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` (fullwidth bars,
 * used by ds-free-api / the official template). */
export const NATIVE_RESULT_BLOCK_PATTERN =
  /<[｜|]tool[▁_]output[▁_]begin[｜|]>([\s\S]*?)<[｜|]tool[▁_]output[▁_]end[｜|]>/g;

/** Matches a `<tool_result …>…</tool_result>` block and captures its inner text. */
const RESULT_PATTERN = RESULT_BLOCK_PATTERN;

/** Reads the `name="…"` / `status="…"` attributes off a result block. */
function resultAttribute(attributes: string, key: string): string | null {
  const match = new RegExp(`${key}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match ? match[1]! : null;
}

/** Finds every `<tool_result>` block in `text`. */
function parseResults(text: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  for (const match of text.matchAll(RESULT_PATTERN)) {
    if (match.index === undefined) continue;
    const attributes = match[1] ?? "";
    const body = (match[2] ?? "").replace(/^\n/, "").replace(/\n$/, "");
    results.push({
      name: resultAttribute(attributes, "name") ?? "tool",
      status: resultAttribute(attributes, "status") ?? "ok",
      body,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (const match of text.matchAll(NATIVE_RESULT_BLOCK_PATTERN)) {
    if (match.index === undefined) continue;
    results.push({
      name: "tool",
      status: "ok",
      body: (match[1] ?? "").replace(/^\n/, "").replace(/\n$/, ""),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}

/** Renders one result block as a card. */
function renderResult(result: ParsedResult): string {
  const label = result.status === "error" ? "执行失败" : "执行结果";
  return card(`${RESULT_CARD_MARK} ${result.name}  ${label}`, renderBody(result.body));
}

/** True when `text` already carries a rendered call card. */
export function hasCallCard(text: string): boolean {
  return text.includes(CALL_CARD_MARK);
}

/** True when `text` already carries a rendered result card. */
export function hasResultCard(text: string): boolean {
  return text.includes(RESULT_CARD_MARK);
}

/**
 * Replaces tool calls in **assistant output** with readable cards.
 *
 * Code fences are skipped, and only calls whose tool names resolve to a real tool
 * are eligible, so arbitrary XML in an answer is left exactly as written.
 *
 * A `<tool_calls>` wrapper holding several calls collapses to **one card per
 * call**, and the wrapper's own tags are dropped with them: an answer that asked
 * for three directories should read as three lines, not as three lines inside a
 * leftover empty wrapper.
 *
 * `presentToolCallsDom` is the variant the content script uses: there, a call
 * inside a `<code>` element has already been HTML-escaped by the renderer, so
 * fences cannot be recognised from the text and the DOM marks the skip instead.
 */
export function presentToolCalls(text: string, knownTools: readonly string[]): string {
  if (!text.includes("<")) return text;
  const fences = fencedRanges(text);
  return renderCalls(text, knownTools, (start) => inRanges(start, fences));
}

/** The DOM-layer entry point: `isCode` marks a tag the renderer already escaped. */
export function presentToolCallsDom(
  text: string,
  knownTools: readonly string[],
  isCode: (start: number) => boolean,
): string {
  return renderCalls(text, knownTools, isCode);
}

/**
 * Deletes every tool-call tag instead of rendering it.
 *
 * Used for the thinking channel, where a tag is inert — the stream parser never
 * scans reasoning, so such a call never ran. It must not become a card, because a
 * card is the record of a call that *did* run.
 */
export function removeToolCalls(text: string, knownTools: readonly string[]): string {
  return stripToolCalls(text, knownTools);
}

/** Shared implementation of both call renderers. */
function renderCalls(
  text: string,
  knownTools: readonly string[],
  isCode: (start: number) => boolean,
): string {
  if (knownTools.length === 0 || !text.includes("<")) return text;

  const { calls, rewrites } = parseToolCalls(text, knownTools);
  if (calls.length === 0) return text;

  interface Edit {
    start: number;
    end: number;
    text: string;
  }
  const edits: Edit[] = [];

  // The rewritten region is the whole wrapper a call belongs to, so the wrapper's
  // own tags disappear along with the call they wrapped — otherwise an answer
  // that asked for three directories would leave three empty wrappers behind.
  // Every call inside one wrapper still gets its own card: the calls are what the
  // user is reading.
  const wrapperFor = (call: { start: number; end: number }): [number, number] | null => {
    for (const [start, end] of rewrites) {
      if (call.start >= start && call.end <= end) return [start, end];
    }
    return null;
  };

  // Claims each wrapper once, so several calls sharing it rewrite one span.
  const claimed = new Map<string, { start: number; end: number; rendered: string[] }>();

  for (const call of calls) {
    if (isCode(call.start)) continue;
    const wrapper = wrapperFor(call);

    if (wrapper === null) {
      edits.push({ start: call.start, end: call.end, text: renderCall(call) });
      continue;
    }

    const key = `${wrapper[0]}-${wrapper[1]}`;
    const entry = claimed.get(key);
    if (entry) entry.rendered.push(renderCall(call));
    else claimed.set(key, { start: wrapper[0], end: wrapper[1], rendered: [renderCall(call)] });
  }

  for (const entry of claimed.values()) {
    // Newline-separated: each card is its own block, and the wrapper's tags were
    // the only thing that used to hold them apart.
    edits.push({ start: entry.start, end: entry.end, text: entry.rendered.join("\n") });
  }

  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // Defensive: overlapping edits cannot happen.
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

/**
 * Replaces `<tool_result>` blocks in an **injected result turn** with cards.
 *
 * Unlike a call, a result body is machine output the user did not type, so it is
 * summarised in place rather than deleted: seeing what a tool returned is the
 * whole point of the turn.
 *
 * The trailing "以上是本机工具的执行结果…" line the bridge appends is dropped here
 * rather than by the scrubber: it is part of the same turn, and letting the
 * scrubber delete one half while this renders the other is what used to produce
 * an empty bubble. Any prose the user typed ahead of the results is preserved.
 */
export function presentToolResults(text: string): string {
  if (!text.includes("<tool_result") && !/tool[▁_]output[▁_]begin/.test(text)) return text;

  const results = parseResults(text);
  if (results.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const result of results) {
    if (result.start < cursor) continue;
    out += text.slice(cursor, result.start) + renderResult(result);
    cursor = result.end;
  }
  out += text.slice(cursor);

  out = out.replace(/<[｜|]tool[▁_]outputs[▁_]begin[｜|]>|<[｜|]tool[▁_]outputs[▁_]end[｜|]>/g, "");
  return dropResultFooters(out);
}

/** Removes the bridge's own trailing line from a rendered result turn. */
function dropResultFooters(text: string): string {
  let out = text;
  for (const footer of INJECTED_RESULT_FOOTERS) {
    out = out.split(footer).join("");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Renders a whole batch of executed tool results as the next turn's text.
 *
 * This is the string the MAIN-world script puts in the composer, which is also
 * what the page renders back into a user bubble — so it lives here, next to the
 * renderer that turns it into a card, rather than in the page hook. The two
 * halves of that round trip cannot then drift apart.
 */
export function buildToolResultTurn(
  results: readonly { name: string; text: string; isError: boolean }[],
  footer: string,
): string {
  // DeepSeek's native tool-output template carries the raw tool result inside
  // output markers (fullwidth bars, matching ds-free-api / the official chat
  // template); it does not add a custom name/status XML envelope.
  const blocks = results.map((result) =>
    `<｜tool▁output▁begin｜>${result.text}<｜tool▁output▁end｜>`,
  );
  return `<｜tool▁outputs▁begin｜>${blocks.join("")}<｜tool▁outputs▁end｜>\n${footer}`;
}
