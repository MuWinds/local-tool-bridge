/**
 * Making the bridge's own plumbing readable — or invisible — in the transcript.
 *
 * Four separate problems live here, and they need three different mechanisms,
 * because CSS alone cannot solve any of the first three.
 *
 * ## 1. Injected text in a user turn (text surgery, not CSS)
 *
 * The web app renders back the **entire prompt it sent**. Measured against the
 * live site, a user bubble is the full injected contract, then the user's own
 * question, then the trailing reminder. The decisive detail: all of that lives in
 * **one text node together with the user's own words**, so no selector can
 * separate them — a rule that hid the bubble would hide the question with it.
 * The injected spans are therefore deleted from the text in place.
 *
 * ## 2. Tool tags in the assistant's final answer (cards, not deletion)
 *
 * A turn that only asked for tools is, in the transcript, a wall of raw XML:
 *
 * ```text
 * <fs_list_dir>{"path": "C:\\Users\\me", "maxEntries": 200}</fs_list_dir>
 * ```
 *
 * That is the protocol leaking into the reading experience. The tag names the
 * tool and the body is its arguments, so the text is rewritten in place into a
 * card (`▸ fs.list_dir  已提交本机执行` / `│ path: …`) and styled by the sheet
 * below. It stays visible because it is the record of what actually ran.
 *
 * ## 3. The tool-result turn (a card, because it used to vanish)
 *
 * A tool result is delivered through the page's own composer, so it arrives as a
 * user message made of `<tool_result …>` blocks and a footer. Deleting all of it
 * left an empty bubble that was then hidden — the result turn silently
 * disappeared, which is worse than showing it. Each block is now summarised in
 * place as a result card instead.
 *
 * ## 4. A turn whose text is *only* a tool call
 *
 * Once the tag is rendered as a card the bubble is not empty, so the
 * "hide what the scrubber emptied" rule no longer swallows legitimately empty
 * turns. That rule is now kind-aware: only a **user** bubble can be hidden for
 * being empty, because only a user bubble is the bridge's own injection. An
 * assistant turn is the page's, and hiding it would hide a real answer.
 *
 * ## Why a MutationObserver, and why it tracks dirty nodes
 *
 * The transcript is a virtual list that re-renders constantly while an answer
 * streams, so a one-shot pass would be undone by the next render. Re-scanning the
 * whole document per frame would be wasteful, so only the subtrees that actually
 * changed are re-examined. Every transform here is idempotent, which is what
 * makes re-running it on a React re-render safe.
 */

import {
  chatMLTokenRanges,
  findInjectedRanges,
  mayContainInjectedText,
  parseToolCalls,
  presentToolCallsDom,
  presentToolResults,
  removeToolCalls,
  type Range,
} from "@dlb/protocol";

/** Elements that can hold injected text, a tool tag, or a result block. */
const SCAN_SELECTOR = ".ds-message, .ds-think-content, .ds-markdown";

/** Attribute marking a bubble that held nothing but bridge plumbing. */
const EMPTY_ATTR = "data-dlb-empty";
/** Attribute on a user bubble that carries a result card. */
const RESULT_ATTR = "data-dlb-result";
/** Attribute on the element that carries a rendered card. */
const CARD_ATTR = "data-dlb-card";

export interface ScrubberConfig {
  /** The exact contract block that was prepended, or null when disabled. */
  systemPrompt: string | null;
  /** The exact reminder appended after the user's text, or null. */
  reminder: string | null;
  /** Tool names whose tags are rendered as cards, or deleted from reasoning. */
  toolNames: string[];
}

const config: ScrubberConfig = {
  systemPrompt: null,
  reminder: null,
  toolNames: [],
};

let observer: MutationObserver | null = null;
/** Token of the pass currently queued, or 0 when nothing is queued. */
let scheduled = 0;
/** Monotonic source for pass tokens. */
let scheduleCounter = 0;
/** The element the observer is currently attached to. */
let observedRoot: Element | null = null;
/** Subtrees queued for the next pass, from mutation records. */
const dirty = new Set<Element>();

/**
 * Disables text selection inside a card.
 *
 * React owns the text node a card lives in, and a re-render rewrites it. A
 * selection anchored inside it would then throw on the next render, so a card is
 * made non-selectable rather than left as a crash waiting for a stray drag.
 */
const CARD_CSS = `
.ds-message span[${CARD_ATTR}="1"] {
  -webkit-user-select: none !important;
  user-select: none !important;
}
`;

/**
 * The visual half of the presentation, injected as a `<style>` element rather
 * than via `insertCSS`, so it needs no `web_accessible_resources` and no extra
 * manifest permission.
 *
 * Colours are deliberately `currentColor`-based with translucent whites and
 * blacks: the sheet does not know whether the page is in its light or dark
 * theme, and both are in use. A neutral tint reads correctly against either.
 *
 * ## Why the selectors insist on a leaf `<span>`
 *
 * The first version of this marked *every* container in the chain — message,
 * markdown body, paragraph — because the attribute was doubling as "this turn was
 * rendered". Styling every marked element then painted the padding and background
 * **three times over**, measured on the live site as a double border and a doubled
 * inset.
 *
 * The marker is now set only on the card element itself, and the selector still
 * pins both facts: it must be a `<span>`, and it must be the innermost marked
 * node. The second half is what keeps a nested marker from ever double-painting
 * again.
 */
const CARD_SELECTOR = `.ds-message span[${CARD_ATTR}="1"]:not(:has([${CARD_ATTR}="1"]))`;

const STYLE_CSS = `
/* An emptied user bubble was pure bridge plumbing. */
.ds-message[${EMPTY_ATTR}="1"] { display: none !important; }

/* A user turn that is a tool-result card: a card, not a chat bubble. */
.ds-message[${RESULT_ATTR}="1"] .fbb737a4 {
  max-width: 100% !important;
  border-radius: 14px !important;
  padding: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

/* The card itself. */
${CARD_SELECTOR} {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.7;
  letter-spacing: 0.01em;
  color: var(--dsw-alias-label-secondary, currentColor);
  background: linear-gradient(180deg, rgba(127,127,127,0.10), rgba(127,127,127,0.045));
  border: 1px solid rgba(127,127,127,0.22);
  border-left: 3px solid rgba(77,107,254,0.55);
  border-radius: 12px;
  padding: 10px 13px 10px 12px;
  margin: 10px 0;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.ds-message[${RESULT_ATTR}="1"] ${CARD_SELECTOR} {
  background: linear-gradient(180deg, rgba(127,127,127,0.14), rgba(127,127,127,0.08));
  border-color: rgba(127,127,127,0.28);
  border-left-color: rgba(127,127,127,0.40);
  border-radius: 14px;
  margin: 4px 0;
}

/* A paragraph that carries nothing but a card is collapsed, so an answer made of
   calls alone does not leave blank lines behind. */
.ds-markdown-paragraph:has([${CARD_ATTR}="1"]),
li:has([${CARD_ATTR}="1"]) {
  margin: 0 !important;
}
`;

/** Collects the text nodes under `root`, in document order. */
function textNodesUnder(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

/**
 * Deletes `ranges` — offsets into the concatenated text of `nodes` — from the
 * live DOM.
 *
 * Offsets are mapped back onto individual nodes, so a range straddling several
 * nodes is handled correctly, which a plain `nodeValue.replace()` could not do.
 * Nodes are processed back-to-front so earlier offsets stay valid as later text
 * is removed.
 */
function deleteRangesFromNodes(nodes: readonly Text[], ranges: readonly Range[]): void {
  if (ranges.length === 0) return;

  const starts: number[] = [];
  let total = 0;
  for (const node of nodes) {
    starts.push(total);
    total += node.nodeValue?.length ?? 0;
  }

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    const value = node.nodeValue ?? "";
    const nodeStart = starts[index]!;
    const nodeEnd = nodeStart + value.length;

    const local: Range[] = [];
    for (const [start, end] of ranges) {
      if (end <= nodeStart || start >= nodeEnd) continue;
      local.push([Math.max(start, nodeStart) - nodeStart, Math.min(end, nodeEnd) - nodeStart]);
    }
    if (local.length === 0) continue;

    // Right-to-left within the node, so offsets stay valid.
    local.sort((a, b) => b[0] - a[0]);
    let next = value;
    for (const [start, end] of local) next = next.slice(0, start) + next.slice(end);
    node.nodeValue = next;
  }
}

/** Whether a node lives inside a rendered code block. */
function isCodeNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return false;
  return element.closest("pre, code, .md-code-block") !== null;
}

/**
 * Whether a node lives inside the reasoning panel.
 *
 * Containers nest — a message holds both its reasoning and its answer — so a pass
 * driven from the message root sees reasoning text too. Reasoning is a different
 * channel with a different rule (a tag there is deleted, never rendered), so the
 * card renderer has to skip those nodes rather than trust where it was called
 * from.
 */
function isThinkingNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return false;
  return element.closest(".ds-think-content") !== null;
}

/**
 * Builds the element that carries a rendered card.
 *
 * The text is set through `textContent` and the line breaks are real `<br>`
 * elements rather than newline characters, so the card keeps its shape even where
 * the page's own stylesheet overrides `white-space`.
 */
function buildCard(text: string): HTMLElement {
  const card = document.createElement("span");
  card.setAttribute(CARD_ATTR, "1");

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) card.appendChild(document.createElement("br"));
    if (line.length > 0) card.appendChild(document.createTextNode(line));
  });
  return card;
}

/**
 * Renders tool calls into cards, across the text nodes of one container.
 *
 * ## Why this cannot be a per-node string transform any more
 *
 * Under the wrapper dialect a single call spans **several** text nodes: the page
 * renders `<tool_calls>`, `<invoke …>`, `<parameter …>` and their values as
 * separate `<br>`-separated nodes. A node holding only `<tool_calls>` contains no
 * call at all, and a node holding one parameter holds a fragment of one.
 *
 * A per-node transform therefore drops a card *between* the wrapper's tags and
 * leaves them behind — measured in the fixture as a card wrapped in a surviving
 * `<tool_calls>`…`</tool_calls>` pair.
 *
 * ## The mechanism: rewrite each node, then blank the leftovers
 *
 * The container's text is parsed as a whole, so calls are found wherever their
 * nodes fall. The single node holding each call's **opening tag** is then cleared
 * (keeping any prose that preceded the block inside it, since a node can straddle
 * the boundary), and a card is inserted there. Every other node the call covers
 * is emptied, because the span of a whole call cannot contain prose.
 *
 * Per call rather than per span: three calls in one wrapper become three cards,
 * and prose written *between* two blocks survives, which replacing the outermost
 * span would have swallowed.
 */
function renderCallCards(element: Element, nodes: readonly Text[], tools: readonly string[]): void {
  if (tools.length === 0) return;

  const usable = nodes.filter((node) => !isCodeNode(node) && !isThinkingNode(node));

  // Where each node's text sits in the container's concatenated text.
  const segments: Array<{ node: Text; from: number; to: number }> = [];
  let combined = "";
  for (const node of usable) {
    const length = (node.nodeValue ?? "").length;
    segments.push({ node, from: combined.length, to: combined.length + length });
    combined += node.nodeValue ?? "";
  }

  if (!combined.includes("<")) return;

  const { calls, rewrites } = parseToolCalls(combined, tools);
  if (calls.length === 0) return;

  const rendered = presentToolCallsDom(combined, tools, () => false);
  if (rendered === combined) return;

  /** The block a call occupies: its wrapper when consumed, else the call itself. */
  const blockFor = (call: { start: number; end: number }): [number, number] => {
    for (const [from, to] of rewrites) {
      if (call.start >= from && call.end <= to) return [from, to];
    }
    return [call.start, call.end];
  };

  // Blocks are rewritten from the last to the first, so emptying the nodes of a
  // later block cannot disturb the offsets that locate an earlier one.
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  const claimed = new Set<string>();

  for (const call of calls) {
    const [start, end] = blockFor(call);
    const key = `${start}-${end}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    // The card's text is the transformed block: one card per call inside it, with
    // the wrapper's own tags already gone.
    blocks.push({ start, end, text: rendered.slice(start, end) });
  }

  blocks.sort((a, b) => b.start - a.start);

  for (const block of blocks) {
    const anchor = segments.find((segment) => segment.to > block.start && segment.from <= block.start);
    if (!anchor) continue;

    // Prose that shares the anchor node with the block's opening tag survives;
    // the block itself is cut out of that node.
    anchor.node.nodeValue = (anchor.node.nodeValue ?? "").slice(0, block.start - anchor.from);

    for (const segment of segments) {
      if (segment.node === anchor.node) continue;
      if (segment.from >= block.start && segment.from < block.end) segment.node.nodeValue = "";
    }

    anchor.node.parentNode?.insertBefore(buildCard(block.text), anchor.node.nextSibling);
  }

  // Deliberately no marker on the container: the card span is the only element
  // that should carry the card's appearance, and a container marker would nest one
  // card inside another. See `CARD_SELECTOR`.
}

/**
 * Renders a batch of `<tool_result>` blocks into a single card.
 *
 * Unlike the call path, this **replaces the wrappers** rather than editing text
 * nodes: a result block spans several `<br>`-separated spans, so no single node
 * holds a whole block. That means removing children React put there — which is
 * only acceptable because this container is a completed result turn, and the
 * transcript is a virtual list that discards and rebuilds these nodes wholesale
 * when the row scrolls out of view rather than reconciling them in place.
 */
function renderResultCards(element: Element, combined: string): boolean {
  // The result turn is now emitted with the native output markers; the legacy
  // `<tool_result>` spelling is kept for turns from older bridge versions.
  if (!combined.includes("<tool_result") && !/tool[▁_]output[▁_]begin/.test(combined)) return false;

  const rendered = presentToolResults(combined).trim();
  if (rendered === combined.trim()) return false;

  element.replaceChildren(buildCard(rendered));
  return true;
}

/**
 * True when this element is the outermost container of its message.
 *
 * A message contributes several scan targets (`.ds-message`, `.ds-markdown`,
 * `.ds-think-content`), and they nest. Only the outermost one is allowed to
 * render a result card, because that path replaces the container's children —
 * doing it from an inner container as well would fight the page's own renderer.
 */
function isMessageRoot(element: Element): boolean {
  return element.querySelector(".ds-message") === null;
}

/** Full pass over one container. */
function scrubElement(element: Element): void {
  const nodes = textNodesUnder(element);
  if (nodes.length === 0) return;

  const inThinking = element.closest(".ds-think-content") !== null;
  const message = element.closest(".ds-message");
  const isAssistant =
    message !== null && message.querySelector(".ds-assistant-message-main-content") !== null;

  // --- Phase 1: structural removal -----------------------------------------
  //
  // Each pass re-reads the live text, so no offset from an earlier pass is ever
  // applied to text that has already shifted.
  const combined = nodes.map((node) => node.nodeValue ?? "").join("");

  if (mayContainInjectedText(combined, config)) {
    // `keepToolResults` is deliberate: the result blocks are this turn's content
    // and the presentation pass below renders them as a card. Deleting them here
    // — or deleting only the footer, whose range then grows over the block above
    // it — is what used to leave an empty bubble behind.
    const injected = findInjectedRanges(combined, { ...config, keepToolResults: true });
    if (injected.length > 0) deleteRangesFromNodes(nodes, injected);

    // The ChatML wrapper tokens surround the injected text on the same line as
    // the user's words, so they are deleted as plain inline ranges after the
    // line-based deletion above — never through findInjectedRanges, whose line
    // expansion would swallow the user's question.
    const surviving = textNodesUnder(element);
    const tokens = chatMLTokenRanges(surviving.map((node) => node.nodeValue ?? "").join(""));
    if (tokens.length > 0) deleteRangesFromNodes(surviving, tokens);
  }

  // A tag written while *thinking* is inert — the parser never scans that
  // channel — so it is deleted rather than shown as a card. A tag in the final
  // answer is the call that actually ran, and becomes a card instead.
  if (inThinking && config.toolNames.length > 0) {
    const afterInjected = textNodesUnder(element);
    const text = afterInjected.map((node) => node.nodeValue ?? "").join("");
    if (text.includes("<")) {
      const stripped = removeToolCalls(text, config.toolNames);
      if (stripped !== text) {
        // Collapsing the reasoning paragraph to one text node is safe: nothing
        // reads or re-renders the reasoning channel, and the alternative — a
        // range deletion — depends on the tag surviving in one text node.
        element.replaceChildren(document.createTextNode(stripped));
      }
    }
  }

  // --- Phase 2: presentation ------------------------------------------------
  //
  // A turn is eligible when the bridge produced it: an answer, or a result turn
  // this extension generated. Pasted text in a user turn is left exactly as
  // written, which is why that case is named rather than inferred.
  //
  // The reasoning channel is excluded here but **not** excluded from the result
  // scan: a container's text includes its reasoning, and a result turn is a user
  // bubble with no reasoning at all. Answer text is the only prose rendered.
  if (message && !inThinking) {
    const answerNodes = textNodesUnder(element).filter((node) => !isThinkingNode(node));
    const answerText = answerNodes.map((node) => node.nodeValue ?? "").join("");
    const isResultTurn =
      answerText.includes("<tool_result") || /tool[▁_]output[▁_]begin/.test(answerText);

    if (isResultTurn || isAssistant || message.getAttribute(RESULT_ATTR) === "1") {
      if (isResultTurn) {
        // The result turn is a user bubble that no marker can identify up front,
        // so the marker is set from the content itself.
        message.setAttribute(RESULT_ATTR, "1");
        if (isMessageRoot(element)) renderResultCards(element, answerText);
      } else {
        renderCallCards(element, answerNodes, config.toolNames);

        // The flag is re-evaluated every pass: a bubble whose card is gone —
        // because the page re-rendered it, or a later edit removed it — must not
        // stay styled as a result turn.
        const stillRendered = message.querySelector(`[${CARD_ATTR}="1"]`) !== null;
        if (!stillRendered) message.removeAttribute(RESULT_ATTR);
      }
    }
  }

  // --- Phase 3: hide a user bubble the bridge emptied ------------------------
  //
  // Only a user bubble: an assistant turn belongs to the page, and a turn that
  // rendered as a card has text even when the model wrote no prose.
  if (!message) return;
  const isEmpty = (message.textContent ?? "").trim().length === 0;
  if (isEmpty && !isAssistant && message.getAttribute(RESULT_ATTR) !== "1") {
    message.setAttribute(EMPTY_ATTR, "1");
  } else {
    message.removeAttribute(EMPTY_ATTR);
  }
}

/** Counters for the observer itself, so "not firing" can be told from "not matching". */
const observerStats = { passes: 0, errors: 0, lastError: "" };

/** Runs one pass over the given scopes, or the whole document when empty. */
function scrubScopes(scopes: Iterable<Element>): void {
  for (const scope of scopes) {
    if (!scope.isConnected) continue;
    // A scope may itself be the matched element or merely contain one.
    if (scope.matches(SCAN_SELECTOR)) scrubElement(scope);
    for (const inner of scope.querySelectorAll(SCAN_SELECTOR)) scrubElement(inner);
  }
}

/**
 * Runs the queued pass.
 *
 * Guarded by `token`: both the frame callback and the fallback timer can fire for
 * the same scheduling, and without the guard the second one runs a *second* full
 * scan — measured on the live site as hundreds of passes per second, which pins
 * the main thread and makes the transcript unusable. The token is also what makes
 * a late callback harmless rather than a duplicate sweep.
 */
function runPass(token: number): void {
  if (token !== scheduled) return; // Superseded or already run.
  scheduled = 0;

  try {
    const scopes = [...dirty];
    dirty.clear();
    observerStats.passes += 1;
    if (scopes.length === 0) scrubScopes(document.querySelectorAll(SCAN_SELECTOR));
    else scrubScopes(scopes);
  } catch (error) {
    observerStats.errors += 1;
    observerStats.lastError = error instanceof Error ? error.message : String(error);
    // Presentation must never break the page or the bridge.
  }
}

/**
 * Coalesces bursts of mutations into one pass on the next frame.
 *
 * The frame callback is only an optimisation: while the document is hidden the
 * browser may stop servicing `requestAnimationFrame` entirely, so a fallback
 * timer runs the pass instead. Without it, a backgrounded tab silently stops
 * presenting anything, and the transcript shows up raw when the user returns.
 */
function schedule(): void {
  if (scheduled !== 0) return;
  const token = ++scheduleCounter;
  scheduled = token;

  if (document.hidden) {
    setTimeout(() => runPass(token), 50);
    return;
  }

  requestAnimationFrame(() => runPass(token));
  // A frame that never arrives (hidden or throttled) must not park the queue.
  setTimeout(() => runPass(token), 250);
}

/** Queues the scan scope nearest to a mutated node. */
function queue(node: Node): void {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return;
  const scope = element.closest(SCAN_SELECTOR) ?? element;
  dirty.add(scope);
}

/** Injects the stylesheet once. */
function injectStyles(): void {
  const STYLE_ID = "__dlb_scrub_styles__";
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CARD_CSS + STYLE_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Applies new configuration and re-scans, since the contract may have changed. */
export function configureScrubber(next: ScrubberConfig): void {
  config.systemPrompt = next.systemPrompt;
  config.reminder = next.reminder;
  config.toolNames = next.toolNames;

  // The contract text changed, so a full re-scan is warranted.
  dirty.clear();
  schedule();
}

/** Starts the scrubber. Safe to call more than once. */
export function startScrubber(): void {
  injectStyles();
  schedule();

  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      queue(record.target);
      for (const node of record.addedNodes) queue(node);
    }
    schedule();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  observedRoot = document.documentElement;

  // A safety net for the cases a MutationObserver cannot cover: the page
  // replacing `documentElement` out from under us during an SPA navigation
  // (which orphans the observer silently), or a frame that never arrived. A slow
  // full sweep costs nothing next to a transcript that stops being presented.
  setInterval(() => {
    if (observer === null) return;
    const root = document.documentElement;
    if (root !== observedRoot) {
      observedRoot = root;
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }
    schedule();
  }, 2000);
}

/**
 * A read-only view of what the presentation layer rendered.
 *
 * The transforms here are invisible from outside the page — a card is a text node
 * plus an attribute, and a hidden bubble is one attribute — so an end-to-end check
 * has no way to tell "rendered" from "not yet run" without a hook. This is a
 * snapshot only, with no way to invoke anything.
 */
export function describePresentation(): {
  cards: number;
  results: number;
  hidden: number;
  rawTags: number;
  styleInjected: boolean;
  passes: number;
  errors: number;
  lastError: string;
} {
  const cards = document.querySelectorAll(`.ds-message span[${CARD_ATTR}="1"]:not(:has([${CARD_ATTR}="1"]))`).length;
  const results = document.querySelectorAll(`.ds-message[${RESULT_ATTR}="1"]`).length;
  const hidden = document.querySelectorAll(`.ds-message[${EMPTY_ATTR}="1"]`).length;

  let rawTags = 0;
  for (const element of document.querySelectorAll(".ds-assistant-message-main-content, .ds-message")) {
    const text = element.textContent ?? "";
    // `rawTags` is the diagnostic for "the presentation pass did not run", so it
    // counts the protocol's own syntax — the wrapper and its invoke — rather than
    // any `<fs_…>` spelling, which the wrapper dialect never emits.
    if (
      /<(?:｜｜DSML｜｜\s*)?(?:tool_calls|calls\b|invoke\s|parameter\s)/.test(text) ||
      /<[｜|]tool[▁_]calls[▁_]begin[｜|]>/.test(text) ||
      /<[｜|]tool[▁_]calls[▁_]end[｜|]>/.test(text) ||
      /<[｜|]tool[▁_]output[▁_]begin[｜|]>/.test(text)
    )
      rawTags += 1;
  }

  return {
    cards,
    results,
    hidden,
    rawTags,
    styleInjected: document.getElementById("__dlb_scrub_styles__") !== null,
    passes: observerStats.passes,
    errors: observerStats.errors,
    lastError: observerStats.lastError,
  };
}
