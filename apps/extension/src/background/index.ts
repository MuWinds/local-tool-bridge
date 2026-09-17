/**
 * The background service worker.
 *
 * It owns the single connection to the local host and is the only place that
 * knows how to reach it. Content scripts ask it to list or call tools; the
 * worker translates those into JSON-RPC and returns the results.
 *
 * MV3 service workers are evicted aggressively, so this file must assume it can
 * be killed between any two events. Two consequences shape the design:
 *
 * 1. **The connection is re-established lazily**, on the first request that
 *    needs it, rather than at startup.
 * 2. **Nothing critical lives in a module-level variable** that a restart would
 *    lose; the tool catalogue is re-fetched when the connection is rebuilt.
 */

import {
  BridgeError,
  RpcErrorCode,
  buildReminder,
  buildSystemPrompt,
  type ToolDescriptor,
  type ToolResult,
} from "@dlb/protocol";
import {
  HttpTransport,
  NativeTransport,
  WebSocketTransport,
  type Transport,
  type TransportStatus,
} from "./transport.js";
import { loadSettings, onSettingsChanged, type Settings } from "../shared/settings.js";

/** Messages the content script and popup exchange with this worker. */
export type WorkerRequest =
  | { kind: "status" }
  | { kind: "connect" }
  | { kind: "disconnect" }
  | { kind: "tools" }
  | { kind: "call"; name: string; arguments: Record<string, unknown>; callId: string; origin: string; conversationId: string | null }
  | { kind: "approve"; token: string; approved: boolean; scope?: "once" | "always" }
  | { kind: "prompt" }
  | { kind: "ping" };

export type WorkerResponse =
  | { kind: "status"; status: TransportStatus }
  | { kind: "tools"; tools: ToolDescriptor[] }
  | { kind: "result"; result: ToolResult }
  | { kind: "prompt"; prompt: string; reminder: string; toolNames: string[] }
  | { kind: "pong" }
  | { kind: "error"; code: number; message: string };

/** Live connection state. Rebuilt after every worker restart. */
let transport: Transport | null = null;
let tools: ToolDescriptor[] = [];
let hostVersion: string | null = null;
let platform: string | null = null;
let lastError: string | null = null;
let settings: Settings | null = null;
/** Serialises connection attempts so two requests cannot race a connect. */
let connecting: Promise<Transport> | null = null;

/** The current status, for the popup and the in-page indicator. */
function status(): TransportStatus {
  return {
    connected: transport !== null,
    kind: transport?.kind ?? null,
    error: lastError,
    hostVersion,
    platform,
  };
}

/** Broadcasts a status change to every content script. */
async function broadcastStatus(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    void chrome.tabs
      .sendMessage(tab.id, { kind: "status-changed", status: status() })
      .catch(() => {
        // The tab may have no content script yet; that is not an error.
      });
  }
}

/** Handles a notification pushed by the host. */
function onNotification(method: string, params: unknown): void {
  if (method === "client.requestApproval") {
    // Surface the prompt in every DeepSeek tab; whichever answers first wins.
    void chrome.tabs.query({ url: "https://chat.deepseek.com/*" }).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        void chrome.tabs
          .sendMessage(tab.id, { kind: "approval-request", challenge: params })
          .catch(() => {});
      }
    });
    return;
  }

  if (method === "bridge.policyChanged") {
    // The tool list may have changed with the policy; refresh it.
    void refreshTools();
    return;
  }

  if (method === "bridge.shuttingDown") {
    transport = null;
    void broadcastStatus();
  }
}

/** Establishes a connection using the configured transport. */
async function connect(): Promise<Transport> {
  if (transport) return transport;
  if (connecting) return connecting;

  const current = settings ?? (await loadSettings());
  settings = current;

  connecting = (async () => {
    try {
      const events = {
        onNotification,
        onDisconnect(reason: string) {
          transport = null;
          lastError = reason;
          void broadcastStatus();
        },
      };

      const next: Transport = await (async () => {
        switch (current.transport) {
          case "http":
            return HttpTransport.connect(events, current.websocketPort, current.secret);
          case "websocket":
            return WebSocketTransport.connect(events, current.websocketPort);
          case "native":
            return NativeTransport.connect(events);
        }
      })();

      // The handshake doubles as a version check. Native messaging is already
      // authenticated by Chrome; the loopback transports need the secret, which
      // HTTP sends as a header and the WebSocket includes in the handshake.
      const hello = await next.request<{
        hostVersion: string;
        platform: string;
        capabilities: { availableTools: string[] };
      }>(
        "bridge.hello",
        {
          protocolVersion: "0.1.0",
          clientVersion: chrome.runtime.getManifest().version,
          clientId: chrome.runtime.id,
          transports: [current.transport],
          ...(current.transport === "native" ? {} : { secret: current.secret }),
        },
        10_000,
      );

      hostVersion = hello.hostVersion;
      platform = hello.platform;
      lastError = null;
      transport = next;

      await refreshTools();
      void broadcastStatus();
      return next;
    } catch (cause) {
      const error = BridgeError.from(cause, RpcErrorCode.HostUnavailable);
      lastError = error.message;
      transport = null;
      void broadcastStatus();
      throw error;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** Drops the connection. */
function disconnect(): void {
  transport?.close();
  transport = null;
  tools = [];
  void broadcastStatus();
}

/** Re-reads the tool catalogue from the host. */
async function refreshTools(): Promise<ToolDescriptor[]> {
  if (!transport) return [];
  const result = await transport.request<{ tools: ToolDescriptor[] }>("tools.list", {}, 10_000);
  tools = result.tools;
  return tools;
}

/** Returns the tool catalogue, connecting first if needed. */
async function ensureTools(): Promise<ToolDescriptor[]> {
  await connect();
  if (tools.length === 0) await refreshTools();
  return tools;
}

/** Tools that are both implemented by the host and enabled by the user. */
function enabledTools(): ToolDescriptor[] {
  const disabled = new Set(settings?.disabledTools ?? []);
  return tools.filter((tool) => !disabled.has(tool.name));
}

/** Builds the injected instruction block and its trailing reminder. */
async function promptPayload(): Promise<{ prompt: string; reminder: string; toolNames: string[] }> {
  const current = settings ?? (await loadSettings());
  const available = enabledTools();
  return {
    prompt: buildSystemPrompt({
      tools: available,
      locale: current.locale,
      maxResultChars: 20_000,
    }),
    reminder: buildReminder(available, current.locale),
    // The hook scopes its parser to these names, so a tool the user disabled
    // cannot be invoked by a tag the model emits anyway.
    toolNames: available.map((tool) => tool.name),
  };
}

/** Routes one message from a content script or the popup. */
async function handle(request: WorkerRequest, sender: chrome.runtime.MessageSender): Promise<WorkerResponse> {
  try {
    switch (request.kind) {
      case "status":
        return { kind: "status", status: status() };

      case "connect":
        await connect();
        return { kind: "status", status: status() };

      case "disconnect":
        disconnect();
        return { kind: "status", status: status() };

      case "tools":
        return { kind: "tools", tools: await ensureTools() };

      case "prompt":
        await ensureTools();
        return { kind: "prompt", ...(await promptPayload()) };

      case "ping":
        await connect();
        return { kind: "pong" };

      case "approve": {
        const active = await connect();
        await active.request("tools.approve", {
          token: request.token,
          approved: request.approved,
          scope: request.scope ?? "once",
        });
        return { kind: "status", status: status() };
      }

      case "call": {
        const active = await connect();

        // The page origin is supplied by the caller, but the sender's own URL is
        // authoritative — a content script cannot claim a different origin than
        // the tab it runs in.
        const origin = sender.url ? new URL(sender.url).origin : request.origin;

        const result = await active.request<ToolResult>(
          "tools.call",
          {
            name: request.name,
            arguments: request.arguments,
            callId: request.callId,
            origin,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          },
          // Tool calls can legitimately run for minutes; the host enforces its
          // own timeout, so this is only a backstop.
          300_000,
        );

        return { kind: "result", result };
      }

      default: {
        const exhaustive: never = request;
        return {
          kind: "error",
          code: RpcErrorCode.InvalidRequest,
          message: `Unknown request: ${JSON.stringify(exhaustive)}`,
        };
      }
    }
  } catch (cause) {
    const error = BridgeError.from(cause);
    return { kind: "error", code: error.code, message: error.message };
  }
}

chrome.runtime.onMessage.addListener((message: WorkerRequest, sender, sendResponse) => {
  // Returning `true` keeps the channel open for the async response.
  void handle(message, sender)
    .then(sendResponse)
    .catch((cause: unknown) => {
      const error = BridgeError.from(cause);
      sendResponse({ kind: "error", code: error.code, message: error.message });
    });
  return true;
});

// Reconnect automatically when the transport setting changes, so the user does
// not have to reload the page after editing the port or secret.
void loadSettings().then((loaded) => {
  settings = loaded;
});

onSettingsChanged((next) => {
  const transportChanged =
    settings !== null &&
    (settings.transport !== next.transport ||
      settings.websocketPort !== next.websocketPort ||
      settings.secret !== next.secret);

  settings = next;

  if (transportChanged && transport) {
    disconnect();
    void connect().catch(() => {});
  } else {
    // The prompt is rebuilt per request, so a tool-toggle change needs no
    // reconnect — but the page should learn about it.
    void broadcastStatus();
  }
});
