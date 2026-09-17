/**
 * Parser for chat.deepseek.com's SSE stream.
 *
 * The web app does **not** use OpenAI's `choices[].delta` shape. It uses a
 * custom patch protocol:
 *
 * ```text
 * data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":"…"}]}
 * data: {"p":"response/fragments/-1/content","o":"APPEND","v":"…"}
 * data: {"v":"…"}                                  // bare append
 * data: {"p":"response/status","v":"FINISHED"}
 * ```
 *
 * Three traps make a naive parser wrong, and each is handled explicitly below:
 *
 * 1. **THINK and RESPONSE fragments share the same patch paths.** A bare
 *    `{"v":"…"}` appends to whichever fragment is *currently* open, so reasoning
 *    text leaks into the answer unless a fragment-type state machine tracks
 *    which one that is. Reasoning must never be searched for tool calls.
 * 2. **`FINISHED` does not mean the stream is over.** With search enabled, the
 *    server keeps sending `search_results` after it, so the reader must not
 *    close on the first `FINISHED`.
 * 3. **Two fragment formats coexist.** Newer streams carry a `type` field;
 *    older ones encode it in the path (`response/thinking_content` vs
 *    `response/content`). Both must be understood.
 */

/** Which channel a chunk of text belongs to. */
export type FragmentType = "think" | "response" | "tool" | "unknown";

/** One decoded stream event. */
export interface StreamEvent {
  /** Raw SSE `event:` name, when present (`ready`, `title`, `toast`, …). */
  event?: string;
  /** Text destined for the answer, or `""` when this event carried none. */
  text: string;
  /** Which channel `text` belongs to. */
  fragment: FragmentType;
  /** Set when the server signalled completion. */
  finished: boolean;
  /** An error the server reported in-band. */
  error?: string;
  /** Search results, when the event carried them. */
  searchResults?: unknown[];
  /** The fully decoded JSON payload, for callers that need the raw shape. */
  raw: unknown;
}

/** The status value that marks a completed answer. */
const FINISHED_STATUS = "FINISHED";

/**
 * Maps a patch path to a fragment type for the *older* path-driven format.
 *
 * Returns `null` when the path carries no type information, which is the cue to
 * fall back to the currently-open fragment.
 */
function typeFromPath(path: string): FragmentType | null {
  if (path.includes("thinking_content") || path.includes("/thinking")) return "think";
  if (path.includes("response/content") || path.endsWith("/content")) return "response";
  if (path.includes("tool")) return "tool";
  return null;
}

/** Normalises the server's fragment type strings. */
function normaliseType(value: unknown): FragmentType | null {
  if (typeof value !== "string") return null;
  switch (value.toUpperCase()) {
    case "THINK":
      return "think";
    case "RESPONSE":
      return "response";
    case "TOOL":
      return "tool";
    default:
      return null;
  }
}

/**
 * Stateful decoder for the DeepSeek SSE stream.
 *
 * Feed it raw bytes; it emits decoded events. The fragment-type state machine
 * lives here so callers never have to reason about patch paths themselves.
 */
export class DeepSeekStreamDecoder {
  #buffer = "";
  /** The fragment type that a bare `{"v":…}` append belongs to. */
  #currentFragment: FragmentType = "unknown";
  #finished = false;

  /** Feeds a chunk and returns every complete event it contained. */
  push(chunk: string): StreamEvent[] {
    this.#buffer += chunk;
    const events: StreamEvent[] = [];

    // SSE frames are separated by a blank line. Keep any trailing partial frame.
    let separator = this.#findSeparator();
    while (separator !== -1) {
      const frame = this.#buffer.slice(0, separator.index);
      this.#buffer = this.#buffer.slice(separator.index + separator.length);

      const event = this.#decodeFrame(frame);
      if (event) events.push(event);

      separator = this.#findSeparator();
    }

    return events;
  }

  /** Locates the next `\n\n` or `\r\n\r\n` frame boundary. */
  #findSeparator(): { index: number; length: number } | -1 {
    const lf = this.#buffer.indexOf("\n\n");
    const crlf = this.#buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }

  /** Decodes one SSE frame into an event, or `null` when it carried nothing. */
  #decodeFrame(frame: string): StreamEvent | null {
    let eventName: string | undefined;
    const dataLines: string[] = [];

    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n").trim();
    if (payload.length === 0) return null;

    // The stream terminates with a bare `[DONE]` sentinel.
    if (payload === "[DONE]") {
      this.#finished = true;
      return { text: "", fragment: "unknown", finished: true, raw: "[DONE]" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A non-JSON frame is not fatal: the server interleaves plain-text
      // keep-alives, and dropping the whole answer over one is worse.
      return null;
    }

    return this.#decodePayload(parsed, eventName);
  }

  /** Applies one decoded JSON payload to the fragment state machine. */
  #decodePayload(parsed: unknown, eventName?: string): StreamEvent | null {
    if (parsed === null || typeof parsed !== "object") return null;
    const envelope = parsed as Record<string, unknown>;

    // In-band errors arrive as `{"type":"error","content":"…"}`.
    if (envelope["type"] === "error") {
      const message = typeof envelope["content"] === "string" ? envelope["content"] : "Unknown stream error";
      return { text: "", fragment: "unknown", finished: false, error: message, raw: parsed };
    }

    const path = typeof envelope["p"] === "string" ? envelope["p"] : undefined;
    const operation = typeof envelope["o"] === "string" ? envelope["o"] : undefined;
    const value = envelope["v"];

    // Completion. Note the stream is *not* closed here: `FINISHED` can be
    // followed by search results.
    if (path === "response/status" && value === FINISHED_STATUS) {
      this.#finished = true;
      return { text: "", fragment: "unknown", finished: true, raw: parsed };
    }
    // The same signal also arrives nested in a batch as `quasi_status`.
    if (path === "quasi_status" && value === FINISHED_STATUS) {
      this.#finished = true;
      return { text: "", fragment: "unknown", finished: true, raw: parsed };
    }
    if (path === "response/search_results" && Array.isArray(value)) {
      return { text: "", fragment: "unknown", finished: false, searchResults: value, raw: parsed };
    }

    // Batch form: `{"p":"response","o":"BATCH","v":[{…},{…}]}`.
    if (operation === "BATCH" && Array.isArray(value)) {
      const collected: string[] = [];
      let fragment: FragmentType = "unknown";
      let finished = false;
      let error: string | undefined;

      for (const item of value) {
        const inner = this.#decodePayload(item, eventName);
        if (!inner) continue;
        if (inner.text) {
          collected.push(inner.text);
          fragment = inner.fragment;
        }
        if (inner.finished) finished = true;
        if (inner.error) error = inner.error;
      }

      if (collected.length === 0 && !finished && !error) return null;
      return { text: collected.join(""), fragment, finished, error, raw: parsed };
    }

    // A fragment array: `[{"type":"THINK","content":"…"}]`. Opening one sets
    // the current fragment, which is what subsequent bare appends attach to.
    if (Array.isArray(value)) {
      const collected: string[] = [];
      let fragment: FragmentType = "unknown";
      for (const item of value) {
        if (item === null || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const declared = normaliseType(entry["type"]);
        if (declared) {
          this.#currentFragment = declared;
          fragment = declared;
        }
        if (typeof entry["content"] === "string") {
          collected.push(entry["content"]);
          if (fragment === "unknown") fragment = this.#currentFragment;
        }
      }
      if (collected.length === 0) return null;
      return { text: collected.join(""), fragment, finished: false, raw: parsed };
    }

    // A plain string append. Which channel it belongs to comes from the path
    // when the path says so, and otherwise from the currently-open fragment —
    // this is the branch that keeps reasoning out of the answer.
    if (typeof value === "string") {
      const fromPath = path ? typeFromPath(path) : null;
      const fragment = fromPath ?? this.#currentFragment;
      if (fromPath) this.#currentFragment = fromPath;
      return { text: value, fragment, finished: false, raw: parsed };
    }

    // Metadata frames (`{"v":{"response":{…}}}`) carry no user-visible text.
    return null;
  }

  /** True once the server has signalled completion. */
  get finished(): boolean {
    return this.#finished;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): string {
    return this.#buffer;
  }

  reset(): void {
    this.#buffer = "";
    this.#currentFragment = "unknown";
    this.#finished = false;
  }
}

/**
 * Accumulates an answer while separating reasoning from response text.
 *
 * The extension feeds every decoded event here and reads the two channels
 * independently, so tool calls are only ever looked for in `response`.
 */
export class AnswerAccumulator {
  #thinking = "";
  #answer = "";
  #finished = false;
  #errors: string[] = [];

  /** Applies one event. */
  apply(event: StreamEvent): void {
    if (event.error) this.#errors.push(event.error);
    if (event.finished) this.#finished = true;
    if (!event.text) return;

    if (event.fragment === "think") this.#thinking += event.text;
    else if (event.fragment === "response") this.#answer += event.text;
    // `tool` and `unknown` fragments are deliberately not merged into either
    // channel: an unattributed fragment cannot be safely attributed, and
    // guessing would reintroduce the bug this class exists to prevent.
  }

  get thinking(): string {
    return this.#thinking;
  }

  get answer(): string {
    return this.#answer;
  }

  get finished(): boolean {
    return this.#finished;
  }

  get errors(): readonly string[] {
    return this.#errors;
  }

  /** Only the answer channel — never reasoning. */
  get toolCallScope(): string {
    return this.#answer;
  }

  reset(): void {
    this.#thinking = "";
    this.#answer = "";
    this.#finished = false;
    this.#errors = [];
  }
}
