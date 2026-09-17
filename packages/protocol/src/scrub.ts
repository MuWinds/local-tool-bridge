import { INJECTED_RESULT_FOOTERS, parseToolCalls, resolveToolName } from "./prompt.js";
import { RESULT_BLOCK_PATTERN } from "./present.js";

/**
 * Locating the text the bridge injects into the page, so it can be removed
 * before the user ever reads it.
 *
 * ## Why this exists
 *
 * The web app renders back to the user the **entire prompt it sent**, not just
 * what was typed. Measured against the live site, a user bubble contains the full
 * injected contract, then the user's own question, then the trailing reminder; a
 * tool-result turn is a wall of `<tool_result>` XML. The model also sometimes
 * writes a tool tag into its *reasoning*, which the page renders verbatim in the
 * thinking panel — inert, since the parser never scans that channel, but it looks
 * like a leak.
 *
 * ## Why ranges rather than a rewritten string
 *
 * The injected contract and the user's own words share a single text node, so no
 * CSS selector can separate them: a rule that hid the bubble would hide the
 * question too. The text must be edited in place.
 *
 * Editing a *live DOM* by string replacement is not safe, because the renderer
 * may have split one logical block across several text nodes — replacing the
 * whole node would then either miss the block or delete the wrong text. So the
 * transforms here report **character ranges** into the concatenated text, and the
 * DOM layer deletes exactly those ranges from whichever nodes they fall in. That
 * works whether a block is one node or twenty.
 *
 * Every function here is pure and browser-free, so it is unit-testable.
 */

/**
 * The bridge's tool-result block, as the scrubber sees it.
 *
 * The definition is shared with the card renderer, so the block the scrubber
 * deletes and the block the presenter rewrites can never be two different
 * patterns.
 */

/**
 * The line the bridge appends after a batch of tool results.
 *
 * Re-exported from [`prompt.ts`](./prompt.ts), which owns the block format this
 * line belongs to. Callers that only need the scrubber keep importing it from
 * here.
 */
export { INJECTED_RESULT_FOOTERS };

/**
 * ChatML wrapper tokens the injector places around the contract and the user's
 * text (`<｜System｜>…<｜end▁of▁sentence｜><｜User｜>…<｜end▁of▁sentence｜><｜Assistant｜>`).
 *
 * They are bridge plumbing, not content, and distinctive enough that a user's
 * own writing never contains them, so they are deleted alongside the contract.
 */
const CHATML_TOKENS: readonly string[] = [
  "<｜System｜>",
  "<｜User｜>",
  "<｜Assistant｜>",
  "<｜end▁of▁sentence｜>",
];

/** A standalone `---` separator line the injector places around the contract. */
const SEPARATOR_LINE = /^\s*---\s*$/;

/** True when a line carries no content of its own. */
function isNoiseLine(line: string): boolean {
  return line.trim().length === 0 || SEPARATOR_LINE.test(line);
}

/** A half-open `[start, end)` character range. */
export type Range = [number, number];

/** Every occurrence of `needle` in `text`, as ranges. */
function occurrences(text: string, needle: string): Range[] {
  const found: Range[] = [];
  if (needle.length === 0) return found;

  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    found.push([at, at + needle.length]);
    from = at + needle.length;
  }
  return found;
}

/**
 * Grows each range to cover the blank and `---` lines that touch it.
 *
 * The injector wraps every block in those separators, so without this the page
 * would be left showing a column of stray horizontal rules where the contract
 * used to be. Expansion is **line-based on purpose**: expanding over raw `-`
 * characters would eat a user's own markdown bullet list.
 */
function expandOverSeparatorLines(text: string, ranges: readonly Range[]): Range[] {
  if (ranges.length === 0) return [];

  // Line table: start offset of every line, plus the text of each.
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    // Largest line whose start is <= offset.
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const lineText = (index: number): string => {
    const from = starts[index]!;
    const to = index + 1 < starts.length ? starts[index + 1]! - 1 : text.length;
    return text.slice(from, to);
  };

  const covered = new Array<boolean>(starts.length).fill(false);
  for (const [start, end] of ranges) {
    // `end` is exclusive; a range ending exactly at a line start must not mark
    // that following line.
    const last = end > start ? lineAt(end - 1) : lineAt(start);
    for (let line = lineAt(start); line <= last; line += 1) covered[line] = true;
  }

  // Absorb adjacent separator-only lines, then merge.
  let changed = true;
  while (changed) {
    changed = false;
    for (let line = 0; line < covered.length; line += 1) {
      if (covered[line]) continue;
      const before = line > 0 && covered[line - 1]!;
      const after = line + 1 < covered.length && covered[line + 1]!;
      if ((before || after) && isNoiseLine(lineText(line))) {
        covered[line] = true;
        changed = true;
      }
    }
  }

  const merged: Range[] = [];
  let line = 0;
  while (line < covered.length) {
    if (!covered[line]) {
      line += 1;
      continue;
    }
    const first = line;
    while (line < covered.length && covered[line]) line += 1;
    const start = starts[first]!;
    const lastLine = line - 1;
    const end = lastLine + 1 < starts.length ? starts[lastLine + 1]! : text.length;
    merged.push([start, end]);
  }
  return merged;
}

/** Sorts and coalesces overlapping or touching ranges. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export interface ScrubOptions {
  /**
   * The exact contract block that was prepended, when known.
   *
   * Removal is by exact match rather than by pattern: the text is known verbatim,
   * and a heuristic that guessed at "looks like an instruction block" would
   * eventually delete a user's own writing.
   */
  systemPrompt?: string | null;
  /** The exact reminder that was appended, when known. */
  reminder?: string | null;
  /**
   * Live tool names, when the caller also re-renders tool tags.
   *
   * Only used by [`mayContainInjectedText`], as the prefilter for a container
   * that holds nothing but a tool call — the case the assistant-side card
   * renderer exists for.
   */
  toolNames?: readonly string[];
  /**
   * Leave `<tool_result>` blocks and their footer in place instead of deleting
   * them.
   *
   * ## Why this needs to be optional, and why it defaults to "delete"
   *
   * Deleting a result block is right for a **string** transform — there is no DOM
   * to render a card into — and it is what the unit tests and the pure helpers
   * assert.
   *
   * It is wrong in the content script now that results are presented rather than
   * thrown away. Two separate mechanisms had to be switched off, and missing
   * either one still emptied the turn:
   *
   * 1. The block pattern deletes the `<tool_result>` block itself.
   * 2. The footer string deletes the "以上是本机工具的执行结果…" line, and
   *    [`expandOverSeparatorLines`] then absorbs the blank lines *and the whole
   *    block* touching it — so removing just the footer removed everything above
   *    it as well. That is the mechanism that produced an empty, hidden bubble.
   */
  keepToolResults?: boolean;
}

/** Matches any tag-shaped construct, so a tool name can be looked for cheaply. */
const TAG_PATTERN = /<([a-zA-Z_][a-zA-Z0-9_.-]*)/g;

/**
 * Finds every character range that must be deleted from `text`.
 *
 * Returns merged, sorted ranges suitable for deletion from a live DOM.
 */
export function findInjectedRanges(text: string, options: ScrubOptions = {}): Range[] {
  const ranges: Range[] = [];
  const keepingResults = options.keepToolResults === true;

  if (!keepingResults) {
    for (const match of text.matchAll(RESULT_BLOCK_PATTERN)) {
      if (match.index === undefined) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  // The footer is part of the result turn, so it is kept with it. Leaving it in
  // the deletion set while the blocks are kept is worse than either choice: the
  // footer's range grows over the blank lines around it and swallows the blocks.
  if (!keepingResults) {
    for (const footer of INJECTED_RESULT_FOOTERS) ranges.push(...occurrences(text, footer));
  }

  for (const fragment of [options.systemPrompt, options.reminder]) {
    if (typeof fragment !== "string" || fragment.length === 0) continue;
    ranges.push(...occurrences(text, fragment));
  }

  return mergeRanges(expandOverSeparatorLines(text, mergeRanges(ranges)));
}

/**
 * Ranges of the ChatML wrapper tokens, as plain inline ranges.
 *
 * The wrapper tokens share a line with the user's own text, so they must NOT go
 * through [`findInjectedRanges`], whose line expansion would swallow the whole
 * line. The DOM layer applies these ranges directly, after the line-based
 * deletion has already run.
 */
export function chatMLTokenRanges(text: string): Range[] {
  const found: Range[] = [];
  for (const token of CHATML_TOKENS) found.push(...occurrences(text, token));
  const withLines: Range[] = found.map(([start, end]) => {
    // Each wrapper token sits on its own line in the injected layout (with a
    // newline before it, after it, or both), so the newlines it was placed with
    // are part of the plumbing: absorb both adjacent newlines when present, so
    // no blank lines survive the deletion. A token inside running text (no
    // adjacent newline) is never extended.
    const from = start > 0 && text[start - 1] === "\n" ? start - 1 : start;
    const to = end < text.length && text[end] === "\n" ? end + 1 : end;
    return [from, to];
  });
  return mergeRanges(withLines);
}

/**
 * Finds the ranges of tool calls whose names resolve to a real tool.
 *
 * The ranges are the **wrapper-aware** ones: a `<tool_calls>` block whose every
 * `<invoke>` resolved is returned as a single range covering the wrapper, so
 * deleting it leaves no empty shell behind. An invoke outside any wrapper is
 * returned on its own.
 *
 * Restricted to known tool names, which is what keeps this from deleting
 * arbitrary XML a user pasted into the conversation.
 */
export function findToolTagRanges(text: string, knownTools: readonly string[]): Range[] {
  if (knownTools.length === 0) return [];
  const outcome = parseToolCalls(text, knownTools);
  return mergeRanges(outcome.rewrites.length > 0 ? outcome.rewrites : outcome.calls.map((call) => [call.start, call.end]));
}

/** Applies `ranges` to a plain string, for tests and non-DOM callers. */
export function deleteRanges(text: string, ranges: readonly Range[]): string {
  let out = "";
  let cursor = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    if (start > cursor) out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}

/**
 * Removes the injected text, leaving whatever the user actually typed.
 *
 * The string form of the transform; the DOM layer uses [`findInjectedRanges`]
 * directly so it can delete across node boundaries.
 */
export function scrubInjectedText(text: string, options: ScrubOptions = {}): string {
  const ranges = findInjectedRanges(text, options);
  if (ranges.length === 0) return text;

  return deleteRanges(text, ranges)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * True when `text` might contain something worth removing.
 *
 * A cheap prefilter: the content script re-examines the whole transcript on every
 * DOM mutation, and running several full-string searches over every paragraph of
 * a long conversation is wasted work.
 */
export function mayContainInjectedText(text: string, options: ScrubOptions = {}): boolean {
  if (text.includes("<tool_result")) return true;
  if (INJECTED_RESULT_FOOTERS.some((footer) => text.includes(footer))) return true;

  for (const fragment of [options.systemPrompt, options.reminder]) {
    if (typeof fragment !== "string" || fragment.length === 0) continue;
    // Compare on a prefix: the contract can be thousands of characters, and
    // searching for the whole thing is what we are trying to avoid.
    const head = fragment.slice(0, 24);
    if (head.length > 0 && text.includes(head)) return true;
  }

  // A tool tag has no fixed spelling, so it is checked by name. This is the only
  // branch that matters for an assistant answer, which never contains the
  // contract (only the user turn does).
  if (options.toolNames && options.toolNames.length > 0 && text.includes("<")) {
    for (const match of text.matchAll(TAG_PATTERN)) {
      if (resolveToolName(match[1] ?? "", options.toolNames) !== null) return true;
    }
  }

  return false;
}
