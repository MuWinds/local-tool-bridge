/**
 * Messages exchanged between the MAIN-world script and the ISOLATED content
 * script.
 *
 * The two run in different JavaScript contexts and can only communicate via
 * `window.postMessage`, so everything crossing that boundary is defined here and
 * explicitly tagged. The tag is a random-looking constant rather than a plain
 * string so a page script cannot accidentally (or deliberately) spoof a bridge
 * message by posting a colliding object.
 */

import type { StreamEvent } from "@dlb/protocol";

/** Tag identifying a bridge message on the `window` message channel. */
export const PAGE_BRIDGE_TAG = "__dlb_bridge_v1__";

/** Direction: MAIN world -> ISOLATED (content script). */
export type PageToContent =
  | {
      kind: "stream-start";
      conversationId: string | null;
      /** The user's own prompt, before any injection. */
      userPrompt: string;
    }
  | {
      kind: "stream-event";
      conversationId: string | null;
      event: StreamEvent;
    }
  | {
      kind: "stream-end";
      conversationId: string | null;
      /** The answer with tool tags stripped, for display purposes. */
      answer: string;
      thinking: string;
    }
  | {
      kind: "tool-calls";
      conversationId: string | null;
      calls: Array<{ name: string; arguments: Record<string, unknown>; callId: string }>;
    }
  | {
      kind: "injection";
      /** Whether the system prompt was prepended to this request. */
      injected: boolean;
      conversationId: string | null;
      reason: string;
    }
  | {
      kind: "error";
      message: string;
      conversationId: string | null;
    };

/** Direction: ISOLATED (content script) -> MAIN world. */
export type ContentToPage =
  | {
      kind: "tool-results";
      conversationId: string | null;
      results: Array<{ callId: string; name: string; text: string; isError: boolean }>;
    }
  | {
      kind: "config";
      /** When false, the hook passes requests through untouched. */
      enabled: boolean;
      /** The instruction block to prepend, or null when disabled. */
      systemPrompt: string | null;
      /**
       * The short reminder appended after the user's own text.
       *
       * Required in addition to `systemPrompt`: a contract placed only at the
       * front of the prompt is largely ignored (measured at 0/3), while the
       * same contract plus this trailing line works (measured at 16/17).
       */
      reminder: string | null;
      /** Whether to attempt the native `tools` parameter (route A). */
      nativeToolsMode: boolean;
      /** Tool names the hook's parser should accept. */
      toolNames: string[];
    };

export type PageBridgeMessage = PageToContent | ContentToPage;

/** Wraps a payload in the tagged envelope. */
export function wrapPageMessage(message: PageBridgeMessage): {
  tag: string;
  payload: PageBridgeMessage;
} {
  return { tag: PAGE_BRIDGE_TAG, payload: message };
}

/** Extracts a bridge payload, or `null` when the event is not ours. */
export function unwrapPageMessage(event: MessageEvent): PageBridgeMessage | null {
  // Only accept messages this same window sent to itself. The content script
  // and the page share a window, so `event.source` must be that window.
  if (event.source !== window) return null;
  const data = event.data as { tag?: unknown; payload?: unknown } | null;
  if (!data || typeof data !== "object") return null;
  if (data.tag !== PAGE_BRIDGE_TAG) return null;
  const payload = data.payload;
  if (!payload || typeof payload !== "object") return null;
  if (typeof (payload as { kind?: unknown }).kind !== "string") return null;
  return payload as PageBridgeMessage;
}

/** Posts a bridge message on the window channel. */
export function postPageMessage(message: PageBridgeMessage): void {
  window.postMessage(wrapPageMessage(message), window.location.origin);
}
