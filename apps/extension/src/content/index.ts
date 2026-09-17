/**
 * The ISOLATED-world content script.
 *
 * It is the only component that can talk to both sides: the MAIN-world hook
 * (via `window.postMessage`) and the extension's service worker (via
 * `chrome.runtime.sendMessage`). The page cannot reach `chrome.*`, and the
 * service worker cannot reach the page's `window`, so this file is the seam.
 *
 * Responsibilities:
 *
 * 1. Push configuration and the instruction block down to the hook.
 * 2. Take tool calls coming up from the hook, execute them through the worker,
 *    and send the results back down.
 * 3. Render the in-page indicator and the approval prompt.
 */

import {
  RpcErrorCode,
  type ToolDescriptor,
  type ToolResult,
} from "@dlb/protocol";
import {
  postPageMessage,
  unwrapPageMessage,
  type PageToContent,
} from "../shared/page-bridge.js";
import type { WorkerRequest, WorkerResponse } from "../background/index.js";
import { configureScrubber, describePresentation, startScrubber } from "./scrubber.js";

/** Sends a message to the service worker and unwraps the response. */
async function ask(request: WorkerRequest): Promise<WorkerResponse> {
  return (await chrome.runtime.sendMessage(request)) as WorkerResponse;
}

/** The latest tool catalogue, used to scope the hook's parser. */
let tools: ToolDescriptor[] = [];
/** True once the hook has signalled that it installed itself. */
let hookReady = false;
/** The conversation the indicator currently refers to. */
let activeConversation: string | null = null;

/** Pushes the current configuration down to the MAIN-world hook. */
async function pushConfig(): Promise<void> {
  // Read the user's own switches first: a disabled extension must leave the page
  // completely untouched, regardless of what the host reports.
  const stored = await chrome.storage.local.get("settings");
  const prefs = (stored["settings"] ?? {}) as { enabled?: boolean; nativeToolsMode?: boolean };
  const userEnabled = prefs.enabled !== false;

  let prompt: string | null = null;
  let reminder: string | null = null;
  let toolNames: string[] = [];

  if (userEnabled) {
    try {
      const response = await ask({ kind: "prompt" });
      if (response.kind === "prompt") {
        prompt = response.prompt;
        reminder = response.reminder;
        toolNames = response.toolNames;
      }
      // On an error the host is unreachable. The page is then left untouched
      // rather than handed a prompt that advertises tools nothing can execute.

      const toolsResponse = await ask({ kind: "tools" });
      if (toolsResponse.kind === "tools") tools = toolsResponse.tools;
    } catch {
      // The service worker may still be starting; the next event retries.
      prompt = null;
    }
  }

  postPageMessage({
    kind: "config",
    enabled: userEnabled && prompt !== null,
    systemPrompt: userEnabled ? prompt : null,
    reminder,
    nativeToolsMode: prefs.nativeToolsMode === true,
    toolNames,
  });

  // The page renders back the whole prompt it sent, so the contract, the
  // tool-result blocks, and the trailing reminder are all deleted from the
  // transcript once the hook reports what was injected. Handing the scrubber the
  // exact strings is what makes that removal precise rather than heuristic.
  configureScrubber({
    systemPrompt: userEnabled ? prompt : null,
    reminder,
    toolNames,
  });
}

/** Renders the tool result into text for the model. */
function renderResult(result: ToolResult): string {
  const body = result.content.map((block) => block.text).join("\n");
  return result.truncated ? `${body}\n[output truncated by the host]` : body;
}

/** Executes one tool call through the worker and returns its rendered result. */
async function executeCall(
  call: { name: string; arguments: Record<string, unknown>; callId: string },
  conversationId: string | null,
): Promise<{ callId: string; name: string; text: string; isError: boolean }> {
  showIndicator(`Running ${call.name}…`, "running");

  try {
    const response = await ask({
      kind: "call",
      name: call.name,
      arguments: call.arguments,
      callId: call.callId,
      origin: window.location.origin,
      conversationId,
    });

    if (response.kind === "result") {
      const isError = response.result.isError === true;
      showIndicator(
        isError ? `${call.name} returned an error` : `${call.name} finished`,
        isError ? "error" : "ok",
      );
      return {
        callId: call.callId,
        name: call.name,
        text: renderResult(response.result),
        isError,
      };
    }

    const message = response.kind === "error" ? response.message : "Unexpected worker response";
    showIndicator(`${call.name} failed: ${message}`, "error");

    // A denial, a timeout, or a missing approval is reported back to the model
    // as an ordinary tool error so it can explain the situation to the user,
    // rather than the conversation silently stalling.
    return { callId: call.callId, name: call.name, text: message, isError: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    showIndicator(`${call.name} failed: ${message}`, "error");
    return { callId: call.callId, name: call.name, text: message, isError: true };
  }
}

/** Handles a batch of tool calls from the hook. */
async function handleToolCalls(message: Extract<PageToContent, { kind: "tool-calls" }>): Promise<void> {
  activeConversation = message.conversationId;

  const results = [];
  for (const call of message.calls) {
    // Calls run sequentially: the host is the shared resource, and a parallel
    // burst is exactly the pattern the upstream risk controls watch for.
    results.push(await executeCall(call, message.conversationId));
  }

  postPageMessage({
    kind: "tool-results",
    conversationId: message.conversationId,
    results,
  });

  // Leave a completed indicator on screen briefly so the user sees what ran.
  setTimeout(() => hideIndicator(), 2500);
}

// ---------------------------------------------------------------------------
// In-page indicator
// ---------------------------------------------------------------------------

const INDICATOR_ID = "__dlb_indicator__";

/** Creates or updates the small status pill in the corner of the page. */
function showIndicator(text: string, state: "running" | "ok" | "error"): void {
  let element = document.getElementById(INDICATOR_ID);
  if (!element) {
    element = document.createElement("div");
    element.id = INDICATOR_ID;
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    // Inline styles only: the page's CSP and stylesheets must not affect this,
    // and injecting a stylesheet would need a web-accessible resource.
    element.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "padding:8px 14px",
      "border-radius:999px",
      "font:500 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
      "color:#fff",
      "box-shadow:0 4px 16px rgba(0,0,0,.24)",
      "pointer-events:none",
      "transition:opacity .2s ease",
      "max-width:60ch",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
    ].join(";");
    document.documentElement.appendChild(element);
  }

  const colors = { running: "#4d6bfe", ok: "#1a9c62", error: "#c0392b" } as const;
  element.style.background = colors[state];
  element.style.opacity = "1";
  element.textContent = text;
}

function hideIndicator(): void {
  const element = document.getElementById(INDICATOR_ID);
  if (element) element.remove();
}

// ---------------------------------------------------------------------------
// Approval prompt
// ---------------------------------------------------------------------------

interface ApprovalChallenge {
  token: string;
  tool: string;
  arguments: unknown;
  reason: string;
  expiresAt: number;
}

/** Shows a modal asking the user to approve one tool call. */
function showApprovalPrompt(challenge: ApprovalChallenge): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "background:rgba(0,0,0,.45)",
    "font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif",
  ].join(";");

  const dialog = document.createElement("div");
  dialog.style.cssText = [
    "background:#fff",
    "color:#1a1a1a",
    "border-radius:12px",
    "padding:20px 22px",
    "max-width:560px",
    "width:calc(100% - 48px)",
    "box-shadow:0 12px 48px rgba(0,0,0,.3)",
  ].join(";");

  const title = document.createElement("h2");
  title.textContent = "允许执行本地工具？";
  title.style.cssText = "margin:0 0 6px;font-size:16px;font-weight:600";

  const reason = document.createElement("p");
  reason.textContent = challenge.reason;
  reason.style.cssText = "margin:0 0 12px;color:#555;font-size:13px";

  const tool = document.createElement("div");
  tool.textContent = challenge.tool;
  tool.style.cssText =
    "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f4f4f5;border-radius:6px;padding:6px 10px;margin-bottom:10px";

  const args = document.createElement("pre");
  args.textContent = JSON.stringify(challenge.arguments, null, 2);
  args.style.cssText = [
    "margin:0 0 16px",
    "padding:10px 12px",
    "background:#1e1e1e",
    "color:#e6e6e6",
    "border-radius:8px",
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
    "max-height:240px",
    "overflow:auto",
    "white-space:pre-wrap",
    "word-break:break-word",
  ].join(";");

  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

  /** Builds one dialog button. */
  const button = (label: string, primary: boolean): HTMLButtonElement => {
    const element = document.createElement("button");
    element.textContent = label;
    element.style.cssText = [
      "border:0",
      "border-radius:8px",
      "padding:8px 16px",
      "font-size:13px",
      "font-weight:500",
      "cursor:pointer",
      primary ? "background:#4d6bfe;color:#fff" : "background:#ececec;color:#1a1a1a",
    ].join(";");
    return element;
  };

  /** Answers the challenge and closes the dialog. */
  const answer = (approved: boolean, scope: "once" | "always"): void => {
    overlay.remove();
    void ask({ kind: "approve", token: challenge.token, approved, scope });
  };

  const reject = button("拒绝", false);
  reject.addEventListener("click", () => answer(false, "once"));

  const once = button("仅本次允许", false);
  once.addEventListener("click", () => answer(true, "once"));

  const always = button("始终允许", true);
  always.addEventListener("click", () => answer(true, "always"));

  buttons.append(reject, once, always);
  dialog.append(title, reason, tool, args, buttons);
  overlay.appendChild(dialog);
  document.documentElement.appendChild(overlay);

  // Auto-decline when the challenge expires, so the host is not left waiting.
  const remaining = challenge.expiresAt - Date.now();
  if (remaining > 0) {
    setTimeout(() => {
      if (document.body.contains(overlay)) answer(false, "once");
    }, remaining);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

window.addEventListener("message", (event) => {
  const message = unwrapPageMessage(event);
  if (!message) return;

  switch (message.kind) {
    case "injection":
      hookReady = true;
      // The hook announced itself; hand it the current configuration.
      void pushConfig();
      break;

    case "tool-calls":
      void handleToolCalls(message);
      break;

    case "stream-end":
      if (message.conversationId) activeConversation = message.conversationId;
      break;

    case "error":
      showIndicator(`Bridge error: ${message.message}`, "error");
      setTimeout(() => hideIndicator(), 4000);
      break;

    default:
      break;
  }
});

// The worker pushes status and approval requests directly to this script.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const typed = message as
    | { kind: "status-changed"; status: { connected: boolean; error: string | null } }
    | { kind: "approval-request"; challenge: ApprovalChallenge };

  if (typed.kind === "status-changed") {
    // A dropped connection means the page must stop advertising tools.
    void pushConfig();
    sendResponse({ ok: true });
    return false;
  }

  if (typed.kind === "approval-request") {
    showApprovalPrompt(typed.challenge);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Settings changes must reach the hook without a page reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["settings"]) void pushConfig();
});

// Initial configuration attempt. The hook posts its own readiness message, but
// a fast page load can beat this listener, so both paths call `pushConfig`.
void pushConfig();

// Presentation cleanup runs independently of the hook: it only needs the
// configuration strings, and must start early so an existing transcript is
// cleaned on reload rather than only after the next message.
startScrubber();

/**
 * A read-only snapshot of the presentation layer, for end-to-end checks.
 *
 * The scrubber's work is invisible from the page's own state — a rendered card is
 * a text node plus a `data-dlb-*` attribute — so without this an external check
 * cannot tell "rendered correctly" from "the observer had not run yet". It is a
 * snapshot only, with nothing invokable, mirroring `window.__dlbDebug`.
 */
document.documentElement.setAttribute("data-dlb-presentation", "pending");
setInterval(() => {
  try {
    document.documentElement.setAttribute(
      "data-dlb-presentation",
      JSON.stringify(describePresentation()),
    );
  } catch {
    // Diagnostics must never break the page.
  }
}, 1000);

// A periodic refresh keeps the injected prompt in step with the host's policy
// and tool list without requiring a reload. The interval is long because the
// prompt only changes when the user edits the bridge settings.
setInterval(() => {
  if (hookReady) void pushConfig();
}, 60_000);
