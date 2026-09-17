/**
 * The prompt-injection tool protocol.
 *
 * ## Why this format
 *
 * Reverse-engineering of chat.deepseek.com established that the web backend
 * **silently ignores** a native `tools[]` field: there is no `tools` key in the
 * upstream request shape at all, and the model simply hallucinates a refusal
 * when one is supplied. Native function calling is therefore not available, and
 * the tool contract has to be expressed as text the model emits itself.
 *
 * The dialect below is the **wrapper** form models reach for unprompted:
 *
 * ```text
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="fs_read_file">
 * <｜｜DSML｜｜ parameter name="path" string="true">C:\tmp\a.txt</｜｜DSML｜｜ parameter>
 * </｜｜DSML｜｜ invoke>
 * </｜｜DSML｜｜ calls>
 * ```
 *
 * Three constraints drove this choice, each from an observed failure mode:
 *
 * 1. **The format the model already wants wins.** A bare-tag dialect
 *    (`<fs_read_file>{"path": …}</fs_read_file>`) was tried first and rejected:
 *    measured over real conversations, the dominant failure was not "no call"
 *    but a call the model wrapped on its own initiative in
 *    `<tool_call><invoke name="…">` — a shape it has seen far more often than
 *    any bespoke tag. Prompting for that same shape removes the mismatch
 *    instead of fighting it, and the wrapper is what makes a call unmistakably
 *    a call rather than incidental markup.
 * 2. **Text parameters beat JSON.** JSON inside the wrapper would put the
 *    escaping burden back on the model, and the single most common real defect
 *    was an unescaped Windows path (`{"path": "C:\tmp"}` is invalid JSON, so the
 *    whole call was dropped). A text parameter carries the path verbatim.
 * 3. **Only known tool names count.** The parser matches the `name` attribute
 *    against the live catalogue, so arbitrary XML appearing in a conversation is
 *    inert: a user cannot forge a call by pasting one.
 *
 * Tool names use underscores (`fs_read_file`) rather than dots: dots are legal
 * in XML names but are unusual enough that compliance suffers. The parser
 * accepts the dotted form too, so either spelling executes.
 */

import type { ToolDescriptor } from "./tools.js";

/**
 * The DSML namespace prefix that every tool-call tag carries.
 *
 * Models emit this prefix unprompted — it is the shape they have seen most
 * often in training. Prompting for the same shape removes the mismatch
 * instead of fighting it. The prefix appears in both opening and closing
 * tags, e.g. `<｜｜DSML｜｜ invoke>…</｜｜DSML｜｜ invoke>`.
 */
export const DSML_PREFIX = "｜｜DSML｜｜";

/** Escape hatch for a call that arrives wrapped in a fence anyway. */
export const TAG_NAME_PATTERN = /[^a-z0-9_]/gi;

/**
 * The wrapper every tool call is emitted inside.
 *
 * Exported because three layers need the identical spelling: the prompt that
 * teaches it, the parser that accepts it, and the tests that assert what the
 * model is told. One constant means those cannot drift.
 */
export const TOOL_CALLS_OPEN = "<｜｜DSML｜｜ calls>";
/** Closing tag of the call wrapper. */
export const TOOL_CALLS_CLOSE = "</｜｜DSML｜｜ calls>";
/** Opens one call inside the wrapper. */
export const INVOKE_OPEN = "<｜｜DSML｜｜ invoke name=";
/** Closing tag of one call. */
export const INVOKE_CLOSE = "</｜｜DSML｜｜ invoke>";
/** Opens one argument inside a call. */
export const PARAMETER_OPEN = "<｜｜DSML｜｜ parameter name=";
/** Closing tag of one argument. */
export const PARAMETER_CLOSE = "</｜｜DSML｜｜ parameter>";

/**
 * DeepSeek's native tool-call vocabulary.  Recent DeepSeek-family templates use
 * these token-like markers instead of the DSML wrapper above.  We do not make
 * this the only dialect because the web app can still produce the DSML form, but
 * accepting both dramatically reduces the number of calls lost to a formatting
 * mismatch.
 */
export const NATIVE_TOOL_CALLS_OPEN = "<|tool▁calls▁begin|>";
export const NATIVE_TOOL_CALLS_CLOSE = "<|tool▁calls▁end|>";
export const NATIVE_TOOL_CALL_OPEN = "<|tool▁call▁begin|>";
export const NATIVE_TOOL_CALL_CLOSE = "<|tool▁call▁end|>";
export const NATIVE_TOOL_SEP = "<|tool▁sep|>";
export const NATIVE_TOOL_OUTPUT_OPEN = "<|tool▁output▁begin|>";
export const NATIVE_TOOL_OUTPUT_CLOSE = "<|tool▁output▁end|>";

/**
 * Maps a canonical tool name to the name the model should emit.
 *
 * Canonical names are dotted (`fs.read_file`) because that reads well as an RPC
 * method; emitted names use underscores because dots, while legal in an
 * attribute, are unusual enough that compliance suffers — and models routinely
 * write `name="fs.read_file"` for a tool advertised as `fs_read_file`. The
 * parser accepts either spelling, so this is a rendering concern only.
 *
 * Deriving the emitted form from the canonical name keeps a single source of
 * truth — there is no second name to drift out of sync.
 */
export function tagNameFor(toolName: string): string {
  return toolName.replace(/[.\-]/g, "_");
}

/** Legacy XML/function-call spellings seen in older DeepSeek generations. */
const LEGACY_FUNCTION_CALL_PATTERN =
  /<tool_call\b[^>]*>\s*(?:<function\s*=\s*(["'])([^"']+)\1\s*>)?([\s\S]*?)(?:<\/function>)?\s*<\/tool_call>/gi;

/** Extracts a conservative legacy `<tool_call>` call from a single block. */
function legacyFunctionCallsIn(text: string): NativeToolCallBlock[] {
  const blocks: NativeToolCallBlock[] = [];
  for (const match of text.matchAll(LEGACY_FUNCTION_CALL_PATTERN)) {
    const raw = match[0] ?? "";
    const name = (match[2] ?? "").trim();
    if (!name) continue;
    const body = (match[3] ?? "").trim();
    const start = match.index ?? 0;
    blocks.push({ name, body, start, end: start + raw.length });
  }
  return blocks;
}

/** Levenshtein distance, used to forgive a near-miss tool name. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row dynamic programming: O(min(a,b)) memory.
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length]!;
}

/**
 * Minimum similarity for a near-miss tool name to be accepted.
 *
 * Models occasionally emit `fs_readfile` for `fs_read_file`. Rejecting outright
 * loses a call that was clearly intended; accepting too loosely risks running the
 * wrong tool. A 0.72 threshold accepts single-character slips on names of this
 * length while keeping distinct tools (`fs_read_file` vs `fs_write_file`) apart —
 * those differ by two characters and score well below the threshold.
 */
const FUZZY_ACCEPT_THRESHOLD = 0.72;

/** Similarity of two strings in `[0, 1]`. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Resolves an emitted tag to a canonical tool name.
 *
 * Returns `null` when the name is not close enough to anything real, which is
 * the common and correct outcome for arbitrary XML in a conversation.
 */
export function resolveToolName(emitted: string, knownTools: readonly string[]): string | null {
  const normalised = emitted.trim().toLowerCase().replace(TAG_NAME_PATTERN, "_");

  for (const tool of knownTools) {
    if (tool.toLowerCase() === normalised) return tool;
    if (tagNameFor(tool).toLowerCase() === normalised) return tool;
  }

  let best: { tool: string; score: number } | null = null;
  for (const tool of knownTools) {
    const score = Math.max(
      similarity(normalised, tool.toLowerCase()),
      similarity(normalised, tagNameFor(tool).toLowerCase()),
    );
    if (!best || score > best.score) best = { tool, score };
  }

  if (!best || best.score < FUZZY_ACCEPT_THRESHOLD) return null;

  // Ambiguity is refused rather than guessed: if two tools are equally close,
  // running either could be wrong in a way the user cannot see.
  const runnerUp = knownTools
    .filter((tool) => tool !== best!.tool)
    .map((tool) =>
      Math.max(
        similarity(normalised, tool.toLowerCase()),
        similarity(normalised, tagNameFor(tool).toLowerCase()),
      ),
    )
    .reduce((max, score) => Math.max(max, score), 0);

  if (runnerUp >= best.score - 0.05) return null;
  return best.tool;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Character offsets of the whole block, so the UI can strip it. */
  start: number;
  end: number;
  /** Raw inner text, kept for error reporting when parsing fails. */
  raw: string;
}

export interface ToolCallParseError {
  /** The tool name the model attempted, when one could be recovered. */
  name: string | null;
  raw: string;
  start: number;
  end: number;
  message: string;
}

export interface ParseOutcome {
  calls: ParsedToolCall[];
  errors: ToolCallParseError[];
  /** True when an invoke is open with no matching close yet (still streaming). */
  incomplete: boolean;
  /**
   * Ranges to delete instead of the bare call ranges: one entry covering a whole
   * `<tool_calls>` wrapper whose every `<invoke>` was claimed as a call.
   *
   * Kept separate from [`ParsedToolCall.start`] because the two answer different
   * questions. A call's own range is what identifies *the call* — the card names
   * it, and a wrapper shared by three calls would otherwise be rendered once per
   * call. This range is what must disappear from the transcript, and it includes
   * the wrapper so no empty `<tool_calls>` shell is left behind.
   */
  rewrites: Array<[number, number]>;
}

/** Renders the JSON-Schema subset into a compact, model-friendly signature. */
function renderSchema(schema: ToolDescriptor["inputSchema"]): string {
  const required = new Set(schema.required ?? []);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(schema.properties)) {
    const optional = required.has(key) ? "" : "?";
    let type: string = value.type;
    if (value.enum) type = value.enum.map((v) => JSON.stringify(v)).join("|");
    else if (value.type === "array" && value.items) type = `${value.items.type}[]`;
    const note = value.description ? `  // ${value.description}` : "";
    parts.push(`${key}${optional}: ${type}${note}`);
  }
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

export interface SystemPromptOptions {
  tools: readonly ToolDescriptor[];
  /** Language for the surrounding prose. Tool names stay English. */
  locale?: "zh" | "en";
  /** Extra operator instructions appended verbatim. */
  extraInstructions?: string;
  /** Max characters of a single tool result the model should expect. */
  maxResultChars?: number;
}

/**
 * The short reminder appended *after* the user's own text.
 *
 * ## Why this exists, and why it is the difference between working and not
 *
 * A field measurement of this exact problem (OmniRoute's `webTools.ts`, against
 * the AI web app) recorded:
 *
 * | contract placement                  | calls succeeded |
 * | ----------------------------------- | --------------- |
 * | full contract prepended, alone       | **0 / 3**       |
 * | full contract + trailing reminder    | **16 / 17**     |
 *
 * A contract stated once, far above the user's question, is effectively ignored:
 * by the time the model generates its answer, the instruction is thousands of
 * tokens behind it. Restating the format immediately before generation is what
 * makes it act.
 *
 * So the injection is deliberately **two-part**: [`buildSystemPrompt`] produces
 * the full contract, and this produces the one-liner that goes after the user's
 * message. Both are required; using only the first is the 0/3 configuration.
 */
export function buildReminder(tools: readonly ToolDescriptor[], _locale: "zh" | "en" = "zh"): string {
  // Kept for protocol compatibility. The current DeepSeek alignment puts the
  // complete tool contract in the native <｜System｜> block; there is no trailing
  // reminder or <think> injection anymore.
  void tools;
  return "";
}

/**
 * Builds the instruction block.
 *
 * The web app sends a flat `prompt` string with no system role, so this text is
 * prepended to the user's own message rather than injected as a separate system
 * turn. Pair it with [`buildReminder`], which goes *after* the user's text — see
 * that function for why the two-part form is essential.
 *
 * The wording is deliberately repetitive and imperative, and it ends with a list
 * of prohibitions, because the dominant failure is not "no call" but a call
 * wrapped in something plausible-looking.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { tools, locale = "zh", extraInstructions, maxResultChars = 20000 } = options;
  const zh = locale === "zh";

  const example = tagNameFor(tools[0]?.name ?? "fs.list_dir");
  const catalogue = tools
    .map(
      (tool) =>
        `- \`${tagNameFor(tool.name)}\` — ${tool.summary}\n  args: ${renderSchema(tool.inputSchema)}`,
    )
    .join("\n");

  const rules = zh
    ? [
        "你可以调用用户本机的工具。需要工具时，把 JSON 数组完整放进 DeepSeek 原生 tool-call 标签：",
        "",
        `${NATIVE_TOOL_CALLS_OPEN}[{"name":"${example}","arguments":{"argument":"value"}}]${NATIVE_TOOL_CALLS_CLOSE}`,
        "",
        "严格遵循以下规则：",
        `1. 数组必须以 ${NATIVE_TOOL_CALLS_OPEN} 开头、以 ${NATIVE_TOOL_CALLS_CLOSE} 结尾，把整个数组完整包裹在标签内。`,
        '2. 每个数组元素是一个 JSON 对象：{"name":"工具名","arguments":{参数 JSON}}。参数必须是有效 JSON，字符串中的反斜杠必须正确转义。',
        "3. 多个工具调用放在同一个数组里，按生成顺序执行；整个回答只能出现一个 tool-call 块。",
        `4. 需要工具时直接输出调用，第一个非空白字符必须是 ${NATIVE_TOOL_CALLS_OPEN}；调用前不要写任何解释、前缀或问候语。`,
        `5. 输出 ${NATIVE_TOOL_CALLS_CLOSE} 后立即停止，不要追加文本，不要用 Markdown 代码围栏包裹。`,
        "6. 工具执行结果会作为下一轮上下文返回；没有收到结果之前绝不要假设工具已经成功。",
        "7. 只使用下面列出的工具，不要创造不存在的工具名。",
        "8. 工具调用必须出现在最终回答通道，不要写入思考内容。",
      ].join("\n")
    : [
        "You can call tools on the user's machine. When a tool is needed, place a JSON array inside the native DeepSeek tool-call tags:",
        "",
        `${NATIVE_TOOL_CALLS_OPEN}[{"name":"${example}","arguments":{"argument":"value"}}]${NATIVE_TOOL_CALLS_CLOSE}`,
        "",
        "Follow these rules strictly:",
        `1. The array must open with ${NATIVE_TOOL_CALLS_OPEN} and close with ${NATIVE_TOOL_CALLS_CLOSE}, wrapping the entire array.`,
        '2. Each array element is a JSON object: {"name":"tool","arguments":{argument JSON}}. Arguments must be valid JSON; escape backslashes inside strings.',
        "3. Multiple calls belong in the same array and execute in order; emit only one tool-call block per answer.",
        `4. When a tool is needed, the first non-whitespace character must be ${NATIVE_TOOL_CALLS_OPEN}; never write a preamble, prefix or greeting before the call.`,
        `5. Stop immediately after ${NATIVE_TOOL_CALLS_CLOSE}; no trailing text, and never wrap the call in Markdown fences.`,
        "6. The host will return tool results as the next context. Never assume a tool succeeded before receiving its result.",
        "7. Only use tools listed below; never invent a tool name.",
        "8. Tool calls belong in the final answer channel, never in reasoning.",
      ].join("\n");


  const header = zh ? "## 可用工具" : "## Available tools";
  const limits = zh
    ? `单个工具结果最多返回约 ${maxResultChars} 个字符，超出部分会被截断。`
    : `A single tool result is capped at roughly ${maxResultChars} characters; anything beyond that is truncated.`;

  const sections = [rules, "", header, catalogue, "", limits];
  if (extraInstructions && extraInstructions.trim().length > 0) {
    sections.push("", zh ? "## 附加说明" : "## Additional instructions", extraInstructions.trim());
  }
  return sections.join("\n");
}

/** Opening tag of a tool result block. */
export const TOOL_RESULT_OPEN = "<tool_result";
/** Closing tag of a tool result block. */
export const TOOL_RESULT_CLOSE = "</tool_result>";

/**
 * The line the bridge appends after a batch of tool results.
 *
 * Kept as a list because the MAIN-world script owns this string and may localise
 * it; every variant that ships must be listed here. It lives beside the block
 * format it belongs to, because two modules need it: the scrubber, which removes
 * the line when it removes the whole result turn, and the presenter, which drops
 * it when it renders that turn as a card instead.
 */
export const INJECTED_RESULT_FOOTERS: readonly string[] = [
  "以上是本机工具的执行结果，请据此继续回答。",
];

/** Renders a tool result for injection back into the conversation. */
export function formatToolResult(
  _name: string,
  result: { content: Array<{ type: "text"; text: string }>; isError: boolean; truncated?: boolean },
): string {
  const body = result.content.map((block) => block.text).join("\n");
  const suffix = result.truncated ? "\n[output truncated by host]" : "";
  // Fullwidth output markers, matching buildToolResultTurn / the canonical
  // DeepSeek tool-output template.
  return `<｜tool▁output▁begin｜>${body}${suffix}<｜tool▁output▁end｜>`;
}

/**
 * JSON repair modelled after mangiucugna/json_repair.
 *
 * The important difference from the old regex-only repair is that we parse the
 * JSON grammar while repairing it.  That lets us recover missing quotes,
 * separators, closing delimiters, comments, prose around a JSON value, single
 * quoted strings, truncated values and invalid escape sequences without touching
 * characters that merely happen to look like JSON syntax inside a string.
 *
 * The upstream project describes the same strategy as a BNF parser with small
 * heuristics for missing parentheses/quotes and whitespace.  We keep the strict
 * JSON.parse fast path and only enter this parser after it fails.
 */
function repairJson(input: string): string {
  const source = input
    .trim()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
  let index = 0;

  const peek = () => source[index];
  const skipSpaceAndComments = () => {
    while (index < source.length) {
      while (/\s/.test(source[index] ?? "")) index += 1;
      if (source.startsWith("//", index)) {
        const end = source.indexOf("\n", index + 2);
        index = end === -1 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
      if (source[index] === "#") {
        const end = source.indexOf("\n", index + 1);
        index = end === -1 ? source.length : end + 1;
        continue;
      }
      break;
    }
  };

  const readQuoted = (quote: string): string => {
    index += 1;
    let out = "";
    while (index < source.length) {
      const ch = source[index]!;
      if (ch === quote) {
        index += 1;
        return out;
      }
      if (ch === "\\") {
        const next = source[index + 1];
        if (next === undefined) {
          out += "\\";
          index += 1;
          return out;
        }
        const escapes: Record<string, string> = {
          '"': '"', "'": "'", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
        };
        if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
          out += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
          index += 6;
          continue;
        }
        if (next in escapes) out += escapes[next]!;
        else out += `\\${next}`; // preserve invalid escapes instead of losing a Windows path
        index += 2;
        continue;
      }
      out += ch;
      index += 1;
    }
    return out;
  };

  const readBareToken = (): string => {
    const start = index;
    while (index < source.length && !/[\s,}\]:]/.test(source[index]!)) index += 1;
    return source.slice(start, index).trim();
  };

  const readString = (): string => {
    const ch = peek();
    if (ch === '"' || ch === "'") return readQuoted(ch);
    return readBareToken();
  };

  const readNumber = (): number | null => {
    const match = source.slice(index).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) return null;
    index += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  };

  const readValue = (): Value => {
    skipSpaceAndComments();
    const ch = peek();
    if (ch === "{") return readObject();
    if (ch === "[") return readArray();
    if (ch === '"' || ch === "'") return readQuoted(ch);
    if (ch === "-" || ch === "." || /\d/.test(ch ?? "")) {
      const number = readNumber();
      if (number !== null) return number;
    }
    const token = readBareToken();
    const lower = token.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (lower === "null" || lower === "none") return null;
    return token;
  };

  const readKey = (): string => {
    skipSpaceAndComments();
    const ch = peek();
    if (ch === '"' || ch === "'") return readQuoted(ch);
    const start = index;
    while (index < source.length && !/[\s:,{\[\]}]/.test(source[index]!)) index += 1;
    return source.slice(start, index).trim();
  };

  const readObject = (): { [key: string]: Value } => {
    index += 1;
    const object: { [key: string]: Value } = {};
    skipSpaceAndComments();
    while (index < source.length) {
      skipSpaceAndComments();
      if (peek() === "}") {
        index += 1;
        break;
      }
      if (peek() === ",") {
        index += 1;
        continue;
      }
      const key = readKey();
      if (!key) {
        index += 1;
        continue;
      }
      skipSpaceAndComments();
      if (peek() === ":") index += 1;
      else if (peek() !== undefined) {
        // json_repair-style recovery: a missing colon is repaired rather than
        // consuming the following value as part of the key.
      }
      skipSpaceAndComments();
      if (peek() === "," || peek() === "}" || peek() === undefined) {
        object[key] = null;
      } else {
        object[key] = readValue();
      }
      skipSpaceAndComments();
      if (peek() === ",") index += 1;
    }
    return object;
  };

  const readArray = (): Value[] => {
    index += 1;
    const array: Value[] = [];
    skipSpaceAndComments();
    while (index < source.length) {
      skipSpaceAndComments();
      if (peek() === "]") {
        index += 1;
        break;
      }
      if (peek() === ",") {
        index += 1;
        continue;
      }
      array.push(readValue());
      skipSpaceAndComments();
      if (peek() === ",") index += 1;
    }
    return array;
  };

  // json_repair also tolerates prose around the actual value.  Start at the
  // first container/primitive that can plausibly be JSON rather than treating
  // the prose as a tool argument.
  const first = source.search(/[\[{\"'\d-]/);
  if (first > 0) index = first;
  const value = readValue();
  return JSON.stringify(value);
}

/**
 * Extracts the first balanced JSON object from `text`, ignoring braces inside
 * string literals. Returns `null` while the object is still incomplete, which is
 * how the stream parser distinguishes "keep buffering" from "malformed".
 *
 * Only the bare-JSON recovery envelope uses this now; the wrapper dialect is
 * parsed structurally.
 */
export function extractJsonObject(text: string): { json: string; end: number } | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Normalises common DeepSeek label hallucinations before parsing.  The native
 * vocabulary is particularly sensitive to `｜` vs `|` and `▁` vs `_`; treating
 * those as equivalent lets the parser recover calls even when the model emits a
 * visually identical ASCII variant.
 */
/** DeepSeek adapter behavior: tool-call tags inside Markdown code fences are examples, not calls. */
function isInsideCodeFence(text: string, position: number): boolean {
  return ((text.slice(0, position).match(/```/g)?.length ?? 0) % 2) === 1;
}

function normaliseNativeLabels(text: string): string {
  return text
    .replace(/[｜|]/g, "|")
    .replace(/[▁_]/g, "_")
    .replace(/<\|DSML\|/g, "<｜DSML｜")
    .replace(/<\|\|DSML\|\|/g, "<｜｜DSML｜｜");
}

interface NativeToolCallBlock {
  name: string;
  body: string;
  start: number;
  end: number;
}

/**
 * Parses the token-like DeepSeek native form:
 *
 * `<｜tool_calls_begin｜><｜tool_call_begin｜>name<｜tool_sep｜>{...}<｜tool_call_end｜>...`
 *
 * The native form uses JSON arguments, so it is repaired independently from the
 * text-parameter DSML parser.  Returned offsets refer to the original text.
 */
function nativeCallsIn(text: string): NativeToolCallBlock[] {
  const source = normaliseNativeLabels(text);
  const open = "<|tool_calls_begin|>";
  const close = "<|tool_calls_end|>";
  const callOpen = "<|tool_call_begin|>";
  const callClose = "<|tool_call_end|>";
  const sep = "<|tool_sep|>";
  const blocks: NativeToolCallBlock[] = [];

  let wrapperAt = source.indexOf(open);
  while (wrapperAt !== -1) {
    const wrapperEnd = source.indexOf(close, wrapperAt + open.length);
    const limit = wrapperEnd === -1 ? source.length : wrapperEnd;
    let at = source.indexOf(callOpen, wrapperAt + open.length);
    while (at !== -1 && at < limit) {
      if (isInsideCodeFence(text, at)) {
        at = source.indexOf(callOpen, at + callOpen.length);
        continue;
      }
      const nameStart = at + callOpen.length;
      const separator = source.indexOf(sep, nameStart);
      if (separator === -1 || separator >= limit) break;
      const callEnd = source.indexOf(callClose, separator + sep.length);
      if (callEnd === -1 || callEnd > limit) break;

      const name = source.slice(nameStart, separator).trim();
      const body = source.slice(separator + sep.length, callEnd).trim();
      const originalStart = at;
      const originalEnd = callEnd + callClose.length;
      if (name.length > 0) {
        blocks.push({ name, body, start: originalStart, end: originalEnd });
      }
      at = source.indexOf(callOpen, callEnd + callClose.length);
    }
    wrapperAt = source.indexOf(open, (wrapperEnd === -1 ? source.length : wrapperEnd + close.length));
  }

  return blocks;
}

/** Parses a recognised native JSON argument payload with the same repair policy. */
/** Fallback dialect supported by ds-free-api: one native call without the outer calls wrapper. */
/**
 * Parses the JSON-array dialect that ds-free-api drives today's web model with:
 *
 * `<|tool▁calls▁begin|>[{"name":"fs_read_file","arguments":{"path":"…"}}]<|tool▁calls▁end|>`
 *
 * The wrapper may also carry a single object instead of an array.  The current
 * web model emits this form (not the per-call token form above) when prompted
 * with the JSON-array contract, so both dialects must parse or every call is
 * silently dropped — which also leaves the wrapper tags raw in the transcript.
 *
 * Returned offsets refer to the original text, and a block spans the **whole
 * wrapper**, so the presenter can delete the tags together with the payload.
 */
function nativeJsonArrayCallsIn(text: string): NativeToolCallBlock[] {
  const source = normaliseNativeLabels(text);
  const open = "<|tool_calls_begin|>";
  const close = "<|tool_calls_end|>";
  const blocks: NativeToolCallBlock[] = [];

  let wrapperAt = source.indexOf(open);
  while (wrapperAt !== -1) {
    const wrapperEnd = source.indexOf(close, wrapperAt + open.length);
    if (wrapperEnd === -1) break;
    const originalEnd = wrapperEnd + close.length;
    const inner = source.slice(wrapperAt + open.length, wrapperEnd);

    if (!isInsideCodeFence(text, wrapperAt)) {
      for (const item of parseNativeJsonArrayItems(inner)) {
        blocks.push({ name: item.name, body: item.body, start: wrapperAt, end: originalEnd });
      }
    }
    wrapperAt = source.indexOf(open, originalEnd);
  }
  return blocks;
}

/** Reads `[{"name":…,"arguments":…}]` (or a single `{…}`) out of wrapper text. */
function parseNativeJsonArrayItems(inner: string): Array<{ name: string; body: string }> {
  const listStart = inner.indexOf("[");
  const listEnd = inner.lastIndexOf("]");
  const objectStart = inner.indexOf("{");
  const objectEnd = inner.lastIndexOf("}");
  const jsonSource =
    listStart !== -1 && listEnd > listStart
      ? inner.slice(listStart, listEnd + 1)
      : objectStart !== -1 && objectEnd > objectStart
        ? inner.slice(objectStart, objectEnd + 1)
        : null;
  if (jsonSource === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(repairJson(jsonSource));
  } catch {
    // The body-level repair in parseNativeArguments cannot help when the item
    // list itself is unparseable; an unclaimed wrapper is left as written.
    return [];
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const result: Array<{ name: string; body: string }> = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name.length === 0) continue;

    let body = "";
    const raw = record.arguments;
    if (raw !== undefined) {
      if (typeof raw === "string") {
        // Models occasionally stringify the arguments object; decode that layer
        // so the value arrives as the object the host expects.
        try {
          body = JSON.stringify(JSON.parse(raw));
        } catch {
          body = raw;
        }
      } else {
        try {
          body = JSON.stringify(raw);
        } catch {
          body = String(raw);
        }
      }
    }
    result.push({ name, body });
  }
  return result;
}

function standaloneNativeCallsIn(text: string): NativeToolCallBlock[] {
  const source = normaliseNativeLabels(text);
  const callOpen = "<|tool_call_begin|>";
  const callClose = "<|tool_call_end|>";
  const sep = "<|tool_sep|>";
  const blocks: NativeToolCallBlock[] = [];
  let at = source.indexOf(callOpen);
  while (at !== -1) {
    if (isInsideCodeFence(text, at)) {
      at = source.indexOf(callOpen, at + callOpen.length);
      continue;
    }
    const separator = source.indexOf(sep, at + callOpen.length);
    const end = separator === -1 ? -1 : source.indexOf(callClose, separator + sep.length);
    if (separator !== -1 && end !== -1) {
      const name = source.slice(at + callOpen.length, separator).trim();
      const body = source.slice(separator + sep.length, end).trim();
      if (name) blocks.push({ name, body, start: at, end: end + callClose.length });
      at = source.indexOf(callOpen, end + callClose.length);
    } else {
      break;
    }
  }
  return blocks;
}

function parseNativeArguments(body: string): Record<string, unknown> | null {
  const extracted = extractJsonObject(body);
  const candidate = extracted?.json ?? body.trim();

  // Fast path: valid JSON should remain byte/semantics preserving.
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the tolerant grammar parser below.
  }

  // DeepSeek occasionally emits a Windows path as `C:\tmp\a.txt`.  Before feeding
  // it to the repair parser, protect drive-letter paths so `\t` is not interpreted
  // as a JSON tab escape.  This is deliberately narrow and leaves normal JSON
  // escapes alone.
  const protectedPaths = candidate.replace(
    /(["'])([A-Za-z]:\\(?:[^"'\\]|\\.)*)(\1)/g,
    (_full, quote: string, inner: string) => `${quote}${inner.replace(/\\/g, "\\\\")}${quote}`,
  );

  try {
    const parsed: unknown = JSON.parse(repairJson(protectedPaths));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to the final quoted-string recovery below.
  }

  // Some generations escape the whole argument object as a JSON string. Decode
  // that one extra layer, but never execute arbitrary text as a call.
  try {
    const decoded = JSON.parse(repairJson(candidate));
    if (typeof decoded === "string") {
      const parsed: unknown = JSON.parse(repairJson(decoded));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Not recoverable; caller leaves the call inert.
  }
  return null;
}

/**
 * Extracts a tool call from a bare JSON envelope.
 *
 * ## Why bare JSON is accepted only here, and only narrowly
 *
 * A field report on this integration notes that a model which emits
 * `{"tool": "...", "arguments": {...}}` as plain text is *describing* a call, and
 * promoting that to a real execution is dangerous: the same shape appears in
 * explanations, in error messages, and in code the model is discussing.
 *
 * So bare JSON is **not** treated as a call during normal parsing. It is only
 * consulted as a last-resort recovery when the answer contains no call at all,
 * and even then the envelope must match one of a small set of exact shapes — an
 * arbitrary object with a `name` key is not enough.
 *
 * Returns `null` when no recognised envelope is present.
 */
export function parseEnvelopeCall(
  text: string,
  knownTools: readonly string[],
): { name: string; arguments: Record<string, unknown>; raw: string } | null {
  // Only exact, known envelope keys are honoured.
  const envelopeKeys = ["tool", "tool_name", "name", "function"] as const;
  const argumentKeys = ["arguments", "args", "parameters", "input", "params"] as const;

  const objects = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  for (const match of text.matchAll(objects)) {
    const body = match[1] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(repairJson(body));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.length > 2) continue;

    const nameKey = envelopeKeys.find((key) => typeof record[key] === "string");
    if (!nameKey) continue;

    // Every other key must be a recognised argument container; a stray key means
    // this object is prose about a call, not a call.
    const otherKeys = keys.filter((key) => key !== nameKey);
    const argumentKey = otherKeys.find((key) =>
      argumentKeys.includes(key as (typeof argumentKeys)[number]),
    );
    if (otherKeys.length > 0 && !argumentKey) continue;

    const canonical = resolveToolName(String(record[nameKey]), knownTools);
    if (canonical === null) continue;

    const rawArguments = argumentKey ? record[argumentKey] : {};
    if (rawArguments === null || typeof rawArguments !== "object" || Array.isArray(rawArguments)) {
      continue;
    }

    return { name: canonical, arguments: rawArguments as Record<string, unknown>, raw: body };
  }

  return null;
}

/** One `<tool_calls>` wrapper, with the invokes it holds. */
interface WrapperBlock {
  start: number;
  end: number;
  children: InvokeBlock[];
}

/** One `<invoke>` block, before its tool name has been resolved. */
interface InvokeBlock {
  name: string;
  body: string;
  start: number;
  end: number;
  /** The wrapper this invoke sits inside, when there is one. */
  wrapper: WrapperBlock | null;
}

/** Matches one `<｜｜DSML｜｜ invoke name="…">…</｜｜DSML｜｜ invoke>` block and captures its body. Prefix is optional for legacy compatibility. */
const INVOKE_PATTERN = /<(?:｜｜DSML｜｜\s+)?invoke\b([^>]*)>([\s\S]*?)<\/(?:｜｜DSML｜｜\s+)?invoke\s*>/g;

/** Matches a `<｜｜DSML｜｜ calls …>…</｜｜DSML｜｜ calls>` wrapper and captures its body. Accepts legacy `<tool_calls>` too. */
const TOOL_CALLS_PATTERN = /<(?:｜｜DSML｜｜\s+)?(?:tool_)?calls\b[^>]*>([\s\S]*?)<\/(?:｜｜DSML｜｜\s+)?(?:tool_)?calls\s*>/g;

/** Matches one `<parameter …>…</parameter>` block and captures its text. */
const PARAMETER_PATTERN = /<(?:｜｜DSML｜｜\s+)?parameter\b([^>]*)>([\s\S]*?)<\/(?:｜｜DSML｜｜\s+)?parameter\s*>/g;

/** An `<invoke …>` with no `</invoke>` after it: a call still streaming in. */
const UNCLOSED_INVOKE_PATTERN =
  /<(?:｜｜DSML｜｜\s+)?invoke\b[^>]*name\s*=\s*("([^"]*)"|'([^']*)')[^>]*>(?![\s\S]*<\/(?:｜｜DSML｜｜\s+)?invoke\s*>)/g;

/** Reads an attribute off a tag, tolerating single quotes and spacing. */
function readAttribute(attributes: string, key: string): string | null {
  const match = new RegExp(`${key}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
  if (!match) return null;
  return match[2] ?? match[3] ?? "";
}

/** Collects every `<invoke>` block in `text`, linked to its wrapper. */
function invokesIn(text: string): InvokeBlock[] {
  const blocks: InvokeBlock[] = [];

  for (const match of text.matchAll(INVOKE_PATTERN)) {
    const attributes = match[1] ?? "";
    // Attributes are scanned after the tag name, so `name="x"` inside a quoted
    // value cannot be mistaken for the attribute itself.
    const name = readAttribute(attributes.replace(/^[^a-zA-Z]*/, ""), "name");
    if (name === null || name.trim().length === 0) continue;
    const start = match.index ?? 0;
    blocks.push({
      name: name.trim(),
      body: match[2] ?? "",
      start,
      end: start + match[0].length,
      wrapper: null,
    });
  }

  // A wrapper claims the invokes inside it, so its own text can be consumed along
  // with them — and containment is decided once, here, rather than by comparing
  // offsets again at every use.
  for (const match of text.matchAll(TOOL_CALLS_PATTERN)) {
    const start = match.index ?? 0;
    const wrapper: WrapperBlock = { start, end: start + match[0].length, children: [] };
    for (const block of blocks) {
      if (block.start >= wrapper.start && block.end <= wrapper.end) {
        block.wrapper = wrapper;
        wrapper.children.push(block);
      }
    }
  }

  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

/**
 * Parses one `<invoke>` body into arguments.
 *
 * ## Why a primitive needs no schema to become primitive
 *
 * The wrapper's `<parameter>` tags carry **text**, because asking for JSON per
 * argument put the escaping burden back on the model and an unescaped Windows
 * path (`C:\tmp`) made the whole call invalid. But the host validates against
 * the tool's JSON Schema, so `"limit": "50"` would be rejected where `50` is
 * required.
 *
 * The declared `type` attribute settles it when the model supplies one; when it
 * does not, text is coerced to the primitive it plainly spells (`50`, `true`).
 * Strings are left exactly as written — a path is never reinterpreted, which is
 * the whole point of the format.
 */
function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let matched = false;

  for (const match of body.matchAll(PARAMETER_PATTERN)) {
    matched = true;
    const attributes = match[1] ?? "";
    const name = readAttribute(attributes, "name");
    if (name === null || name.trim().length === 0) continue;

    // `string="true"` is the dialect's own spelling of a declared string; a
    // `type="…"` attribute is still honoured for the other primitives.
    const declared =
      readAttribute(attributes, "type")?.toLowerCase() ??
      (readAttribute(attributes, "string") === "true" ? "string" : null);
    args[name.trim()] = coerceParameter(match[2] ?? "", declared);
  }

  // Fallback: an `<invoke>` whose body is a JSON object, which is what a model
  // trained on the previous dialect still emits.
  if (!matched) {
    const extracted = extractJsonObject(body);
    if (extracted) {
      try {
        const parsed: unknown = JSON.parse(repairJson(extracted.json));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Left as no arguments; the caller reports the failure.
      }
    }
  }

  return args;
}

/**
 * Trims a parameter value without touching what is inside it.
 *
 * The prompt asks for one `<parameter>` per line, so the body usually arrives
 * wrapped in a newline and indentation that are layout, not content. Trailing and
 * leading whitespace is therefore dropped — but *inner* newlines are kept, since
 * a multi-line file body is a legitimate value.
 */
function trimParameter(raw: string): string {
  return raw.replace(/^\s+/, "").replace(/\s+$/, "");
}

/** Converts one parameter's text into the value the host expects. */
function coerceParameter(raw: string, declared: string | null): unknown {
  const text = trimParameter(raw);

  // A declared `string` is authoritative: `12345` as file content or a path made
  // of digits must stay text, and this is the only signal saying so.
  if (declared === "string") return text;

  if (declared !== null) {
    if (declared === "integer" || declared === "number") {
      const value = Number(text);
      return Number.isFinite(value) ? value : text;
    }
    if (declared === "boolean") return text.toLowerCase() === "true";
    if (declared === "array" || declared === "object" || declared === "json") {
      try {
        return JSON.parse(repairJson(text));
      } catch {
        return text;
      }
    }
    return text;
  }

  // Undeclared: only the shapes that are unambiguous become non-strings.
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
    try {
      return JSON.parse(repairJson(text));
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Extracts every complete tool call from `text`, matching only against names in
 * `knownTools` (canonical, dotted names).
 *
 * Restricting to known names is a security property, not just tidiness: it means
 * a wrapper a user pastes into the conversation can never be executed, because
 * the parser only accepts names the host actually implements. Near-misses are
 * resolved through [`resolveToolName`], which refuses ambiguity.
 */
export function parseToolCalls(text: string, knownTools: readonly string[]): ParseOutcome {
  const calls: ParsedToolCall[] = [];
  const errors: ToolCallParseError[] = [];
  const rewrites: Array<[number, number]> = [];
  let incomplete = false;

  // First accept the native DeepSeek token vocabulary.  This is deliberately
  // additive: the existing DSML parser remains authoritative for the web bridge
  // dialect and both forms are validated against the same live tool catalogue.
  for (const block of nativeCallsIn(text)) {
    const canonical = resolveToolName(block.name, knownTools);
    if (canonical === null) continue;
    const args = parseNativeArguments(block.body);
    if (args === null) {
      errors.push({
        name: canonical,
        raw: block.body,
        start: block.start,
        end: block.end,
        message: "Could not parse native DeepSeek tool arguments as JSON",
      });
      continue;
    }
    calls.push({
      name: canonical,
      arguments: args,
      start: block.start,
      end: block.end,
      raw: block.body,
    });
  }

  const nativeStarts = new Set(calls.map((call) => call.start));

  // The JSON-array dialect: the wrapper carries `[{"name":...,"arguments":...}]`
  // instead of per-call markers.  Blocks span the whole wrapper, so a resolved
  // call below also makes the wrapper itself a rewrite target.
  for (const block of nativeJsonArrayCallsIn(text)) {
    const canonical = resolveToolName(block.name, knownTools);
    if (canonical === null) continue;
    const args = parseNativeArguments(block.body);
    if (args === null) continue;
    calls.push({
      name: canonical,
      arguments: args,
      start: block.start,
      end: block.end,
      raw: block.body,
    });
  }

  for (const block of standaloneNativeCallsIn(text)) {
    if (nativeStarts.has(block.start)) continue;
    const canonical = resolveToolName(block.name, knownTools);
    if (canonical === null) continue;
    const args = parseNativeArguments(block.body);
    if (args === null) continue;
    calls.push({ name: canonical, arguments: args, start: block.start, end: block.end, raw: block.body });
    nativeStarts.add(block.start);
  }

  for (const block of legacyFunctionCallsIn(text)) {
    const canonical = resolveToolName(block.name, knownTools);
    if (canonical === null) continue;
    const args = parseNativeArguments(block.body);
    if (args === null) continue;
    calls.push({
      name: canonical,
      arguments: args,
      start: block.start,
      end: block.end,
      raw: block.body,
    });
  }

  const blocks = invokesIn(text);
  const consumed = new Set<WrapperBlock>();

  for (const block of blocks) {
    const canonical = resolveToolName(block.name, knownTools);

    // An unresolvable name is inert: it is neither a call nor an error, because
    // arbitrary XML in a conversation is expected and must not be reported.
    if (canonical === null) continue;

    calls.push({
      name: canonical,
      arguments: parseParameters(block.body),
      start: block.start,
      end: block.end,
      raw: block.body,
    });

    // The wrapper is consumed along with its calls, so the UI can delete the
    // whole block instead of leaving an empty `<tool_calls>` shell behind.
    const wrapper = block.wrapper;
    if (wrapper === null || consumed.has(wrapper)) continue;

    // A wrapper is only consumed when *every* invoke inside it resolved. One
    // holding an unresolved invoke is left alone: deleting text the parser never
    // claimed would swallow a page's own markup.
    const inner = wrapper.children;
    const claimed = inner.filter((other) => resolveToolName(other.name, knownTools) !== null);
    if (claimed.length !== inner.length) continue;

    consumed.add(wrapper);
    rewrites.push([wrapper.start, wrapper.end]);
  }

  // An invoke still waiting for its `</invoke>` means the answer is still
  // streaming. Unresolvable names are ignored, so stray markup cannot make the
  // parser wait forever.
  for (const match of text.matchAll(UNCLOSED_INVOKE_PATTERN)) {
    const emitted = match[2] ?? match[3] ?? "";
    if (resolveToolName(emitted, knownTools) !== null) incomplete = true;
  }

  // JSON-array dialect, streamed: an open wrapper with a resolvable name
  // already visible means more tokens are coming; keep buffering.
  const nativeSource = normaliseNativeLabels(text);
  const wrapperOpenTag = "<|tool_calls_begin|>";
  const wrapperCloseTag = "<|tool_calls_end|>";
  let openWrapperAt = nativeSource.indexOf(wrapperOpenTag);
  while (openWrapperAt !== -1) {
    const closeAt = nativeSource.indexOf(wrapperCloseTag, openWrapperAt + wrapperOpenTag.length);
    if (closeAt !== -1) {
      openWrapperAt = nativeSource.indexOf(wrapperOpenTag, closeAt + wrapperCloseTag.length);
      continue;
    }
    const tail = nativeSource.slice(openWrapperAt + wrapperOpenTag.length);
    const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(tail);
    if (nameMatch && resolveToolName(nameMatch[1] ?? "", knownTools) !== null) incomplete = true;
    break;
  }

  // Native calls are commonly streamed one token at a time. A known call marker
  // without its closing marker means "keep buffering", not "malformed".
  const nativeOpen = "<|tool_call_begin|>";
  const nativeClose = "<|tool_call_end|>";
  let nativeAt = nativeSource.indexOf(nativeOpen);
  while (nativeAt !== -1) {
    const end = nativeSource.indexOf(nativeClose, nativeAt + nativeOpen.length);
    if (end === -1) {
      const separator = nativeSource.indexOf("<|tool_sep|>", nativeAt + nativeOpen.length);
      if (separator !== -1) {
        const emitted = nativeSource.slice(nativeAt + nativeOpen.length, separator).trim();
        if (resolveToolName(emitted, knownTools) !== null) incomplete = true;
      }
      break;
    }
    nativeAt = nativeSource.indexOf(nativeOpen, end + nativeClose.length);
  }

  // A native wrapper is consumed together with its calls, so the presenter
  // replaces the whole block (tags included) instead of leaving a raw
  // `<|tool▁calls▁begin|>` / `<|tool▁calls▁end|>` pair behind.  The scan uses
  // the normalised text; normalisation is length-preserving (U+FF5C -> | and
  // U+2581 -> _), so its offsets are valid against the original string.
  const wrapperOpen = "<|tool_calls_begin|>";
  const wrapperClose = "<|tool_calls_end|>";
  const seenWrappers = new Set<string>();
  let wrapperAt = nativeSource.indexOf(wrapperOpen);
  while (wrapperAt !== -1) {
    const wrapperEnd = nativeSource.indexOf(wrapperClose, wrapperAt + wrapperOpen.length);
    if (wrapperEnd === -1) break;
    const originalEnd = wrapperEnd + wrapperClose.length;
    const key = `${wrapperAt}-${originalEnd}`;
    const resolved = calls.filter(
      (call) => call.start >= wrapperAt && call.end <= originalEnd && !isInsideCodeFence(text, call.start),
    );
    if (!seenWrappers.has(key) && resolved.length > 0) {
      seenWrappers.add(key);
      rewrites.push([wrapperAt, originalEnd]);
    }
    wrapperAt = nativeSource.indexOf(wrapperOpen, originalEnd);
  }

  calls.sort((a, b) => a.start - b.start);
  errors.sort((a, b) => a.start - b.start);
  rewrites.sort((a, b) => a[0] - b[0]);
  return { calls, errors, incomplete, rewrites };
}

/**
 * Removes tool call blocks so the user never sees the raw protocol.
 *
 * An `<invoke>` is deleted even when its name does not resolve, because inside a
 * `<tool_calls>` wrapper there is no other reading of it: the wrapper is the
 * bridge's own syntax, and leaving a stray `<invoke>` behind would leak protocol
 * noise into the transcript.
 */
export function stripToolCalls(text: string, knownTools: readonly string[]): string {
  const removed: Array<[number, number]> = [];
  for (const block of invokesIn(text)) {
    if (block.wrapper === null && resolveToolName(block.name, knownTools) === null) continue;
    removed.push([block.start, block.end]);
  }
  // Every wrapper goes, even one holding an invoke this parser does not claim:
  // `<tool_calls>` is the bridge's own syntax, never the page's, so nothing under
  // it is content the transcript is losing.
  for (const match of text.matchAll(TOOL_CALLS_PATTERN)) {
    const start = match.index ?? 0;
    removed.push([start, start + match[0].length]);
  }

  for (const block of nativeCallsIn(text)) {
    if (resolveToolName(block.name, knownTools) !== null) removed.push([block.start, block.end]);
  }
  for (const block of nativeJsonArrayCallsIn(text)) {
    if (resolveToolName(block.name, knownTools) !== null) removed.push([block.start, block.end]);
  }
  for (const block of standaloneNativeCallsIn(text)) {
    if (resolveToolName(block.name, knownTools) !== null) removed.push([block.start, block.end]);
  }

  for (const block of legacyFunctionCallsIn(text)) {
    if (resolveToolName(block.name, knownTools) !== null) removed.push([block.start, block.end]);
  }

  const nativeText = normaliseNativeLabels(text);
  const nativeOpen = "<|tool_calls_begin|>";
  const nativeClose = "<|tool_calls_end|>";
  let nativeWrapper = nativeText.indexOf(nativeOpen);
  while (nativeWrapper !== -1) {
    const nativeEnd = nativeText.indexOf(nativeClose, nativeWrapper + nativeOpen.length);
    if (nativeEnd === -1) break;
    const originalEnd = nativeEnd + nativeClose.length;
    const wrapperBody = nativeText.slice(nativeWrapper + nativeOpen.length, nativeEnd);
    const hasKnown = [
      ...nativeCallsIn(nativeOpen + wrapperBody + nativeClose),
      ...nativeJsonArrayCallsIn(nativeOpen + wrapperBody + nativeClose),
    ].some((block) => resolveToolName(block.name, knownTools) !== null);
    if (hasKnown) removed.push([nativeWrapper, originalEnd]);
    nativeWrapper = nativeText.indexOf(nativeOpen, originalEnd);
  }

  removed.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start < cursor) {
      cursor = Math.max(cursor, end);
      continue;
    }
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Incremental parser for the streaming answer.
 *
 * Feed it deltas; it emits each tool call exactly once, as soon as the tag
 * containing it is complete. This is what lets the extension start running a
 * tool while the model is still writing the rest of its answer.
 */
export class ToolCallStreamParser {
  #buffer = "";
  #emitted = 0;
  #knownTools: readonly string[];

  constructor(knownTools: readonly string[]) {
    this.#knownTools = knownTools;
  }

  /** Appends a delta and returns any newly-completed calls. */
  push(delta: string): ParsedToolCall[] {
    this.#buffer += delta;
    const outcome = parseToolCalls(this.#buffer, this.#knownTools);
    const fresh = outcome.calls.slice(this.#emitted);
    this.#emitted = outcome.calls.length;
    return fresh;
  }

  get calls(): ParsedToolCall[] {
    return parseToolCalls(this.#buffer, this.#knownTools).calls;
  }

  get errors(): ToolCallParseError[] {
    return parseToolCalls(this.#buffer, this.#knownTools).errors;
  }

  /** The full text received so far, tags included. */
  get raw(): string {
    return this.#buffer;
  }

  /** True while an opening tag is still waiting for its close. */
  get incomplete(): boolean {
    return parseToolCalls(this.#buffer, this.#knownTools).incomplete;
  }

  /** The answer with every tool call block removed. */
  get visibleText(): string {
    return stripToolCalls(this.#buffer, this.#knownTools);
  }

  reset(): void {
    this.#buffer = "";
    this.#emitted = 0;
  }
}

