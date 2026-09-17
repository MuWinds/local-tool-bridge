/**
 * The transport abstraction.
 *
 * The bridge supports two channels to the local host and the extension can use
 * either:
 *
 * - **Native messaging** — Chrome launches the host binary itself. The browser
 *   enforces the extension allowlist, so it is the stricter option and the right
 *   default for a packaged release. It needs a registered host manifest.
 * - **Loopback WebSocket** — the host listens on `127.0.0.1`. It needs no
 *   registration, which makes it far easier to develop against, but it is
 *   reachable by any local process, so it is gated by a shared secret.
 *
 * Both carry identical JSON-RPC envelopes, so nothing above this layer knows
 * which one is in use.
 */

import {
  BridgeError,
  JsonRpcFailure,
  NativeMessageDecoder,
  RpcErrorCode,
  decodeJsonRpc,
  encodeNativeMessage,
  isJsonRpcFailure,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@dlb/protocol";

/** The native messaging host name, matching the installed host manifest. */
export const NATIVE_HOST_NAME = "com.local_tool_bridge.host";

/** Default loopback port; the host prints its actual port on startup. */
export const DEFAULT_WEBSOCKET_PORT = 8788;

/** The single RPC endpoint on the loopback HTTP transport. */
export const HTTP_RPC_PATH = "/rpc";

export type TransportKind = "native" | "http" | "websocket";

export interface TransportStatus {
  connected: boolean;
  kind: TransportKind | null;
  /** Last connection error, for display in the popup. */
  error: string | null;
  hostVersion: string | null;
  platform: string | null;
}

/** Events a transport reports to its owner. */
export interface TransportEvents {
  /** A notification the host pushed without being asked. */
  onNotification(method: string, params: unknown): void;
  /** The connection dropped. */
  onDisconnect(reason: string): void;
}

/** A bidirectional JSON-RPC channel to the host. */
export interface Transport {
  readonly kind: TransportKind;
  /** Sends a request and resolves with its result. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Sends a notification with no reply expected. */
  notify(method: string, params?: unknown): void;
  /** Closes the channel. */
  close(): void;
}

/** How long to wait for a reply before failing a request. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Base class holding the request/reply bookkeeping both transports share. */
abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;

  protected readonly events: TransportEvents;
  protected pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  protected nextId = 1;
  protected closed = false;

  constructor(events: TransportEvents) {
    this.events = events;
  }

  abstract send(payload: string): void;
  abstract close(): void;

  /**
   * Sends a request and resolves with its result.
   *
   * Overridden by `HttpTransport`, where each call is its own round trip and the
   * pending-map below is unnecessary.
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new BridgeError(RpcErrorCode.HostUnavailable, "The bridge transport is closed"),
      );
    }

    const id = this.nextId++;
    const envelope: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            RpcErrorCode.ToolTimeout,
            `The host did not answer \`${method}\` within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.send(JSON.stringify(envelope));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(BridgeError.from(cause, RpcErrorCode.HostUnavailable));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    } catch {
      // A notification has no reply, so a failure is only worth a log.
      console.warn(`[dlb] failed to send notification ${method}`);
    }
  }

  /** Routes one decoded inbound message. */
  protected handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = decodeJsonRpc(raw);
    } catch {
      return;
    }

    if (isJsonRpcFailure(message) || isJsonRpcSuccess(message)) {
      this.settle(message as JsonRpcResponse);
      return;
    }

    // A host-originated request (e.g. an approval prompt) or a notification.
    if (isJsonRpcRequest(message)) {
      const request = message as JsonRpcRequest;
      this.events.onNotification(request.method, request.params);
      // The host expects a reply to a request, even if only to acknowledge.
      try {
        this.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { received: true } }));
      } catch {
        // Ignored: the host will time out its own prompt.
      }
      return;
    }

    const notification = message as { method?: string; params?: unknown };
    if (typeof notification.method === "string") {
      this.events.onNotification(notification.method, notification.params);
    }
  }

  /** Resolves or rejects the promise waiting on a reply id. */
  private settle(response: JsonRpcResponse): void {
    const id = typeof response.id === "number" ? response.id : Number(response.id);
    const entry = this.pending.get(id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(id);

    if (isJsonRpcFailure(response)) {
      entry.reject(
        new BridgeError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      );
    } else {
      entry.resolve((response as { result: unknown }).result);
    }
  }

  /** Rejects every in-flight request, so nothing hangs forever. */
  protected failAll(reason: string): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(RpcErrorCode.HostUnavailable, reason));
    }
    this.pending.clear();
  }
}

/**
 * Loopback HTTP transport.
 *
 * ## Why this is the recommended default
 *
 * Chrome 142 introduced Local Network Access: a request from a public origin to
 * loopback is gated behind a user permission prompt, and WebSockets were folded
 * in from Chrome 147. Chrome's guidance is explicit that **extension service
 * workers holding the necessary `host_permissions` are exempt**, while a page's
 * main world is not. Two consequences follow:
 *
 * 1. The extension's service worker must own the local channel — a page script
 *    can no longer reliably reach `127.0.0.1`, and a content script inherits the
 *    page's origin and CORS rules regardless of `host_permissions`.
 * 2. Request/response HTTP is the right shape for MV3. A persistent WebSocket is
 *    a documented service-worker keep-alive anti-pattern: it pins the worker
 *    awake. HTTP lets the worker sleep and wake on demand.
 *
 * The shared secret is sent as a header rather than in the body, so it stays out
 * of anything that might log a request payload.
 */
export class HttpTransport extends BaseTransport {
  readonly kind = "http" as const;

  #port: number;
  #secret: string;

  private constructor(port: number, secret: string, events: TransportEvents) {
    super(events);
    this.#port = port;
    this.#secret = secret;
  }

  /** Verifies the host is reachable before declaring the transport usable. */
  static async connect(
    events: TransportEvents,
    port = DEFAULT_WEBSOCKET_PORT,
    secret = "",
  ): Promise<HttpTransport> {
    const transport = new HttpTransport(port, secret, events);

    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "GET",
        cache: "no-store",
      });
    } catch (cause) {
      throw new BridgeError(
        RpcErrorCode.HostUnavailable,
        `Could not reach http://127.0.0.1:${port}. Is the bridge host running? (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }

    if (!response.ok) {
      throw new BridgeError(
        RpcErrorCode.HostUnavailable,
        `The bridge host answered ${response.status} on its health probe`,
      );
    }

    return transport;
  }

  /**
   * Sends one request over HTTP.
   *
   * `BaseTransport.request` handles the promise bookkeeping for a socket-based
   * transport, but HTTP is request/response: each call is its own round trip, so
   * this override bypasses the pending-map entirely.
   */
  override async request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) {
      throw new BridgeError(RpcErrorCode.HostUnavailable, "The bridge transport is closed");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`http://127.0.0.1:${this.#port}${HTTP_RPC_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dlb-secret": this.#secret,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
        cache: "no-store",
      });

      if (response.status === 401) {
        throw new BridgeError(
          RpcErrorCode.NotAuthenticated,
          "The bridge secret was rejected. Copy the current token from the bridge window.",
        );
      }

      const payload = (await response.json()) as JsonRpcResponse;

      if (isJsonRpcFailure(payload)) {
        throw new BridgeError(payload.error.code, payload.error.message, payload.error.data);
      }
      if (isJsonRpcSuccess(payload)) {
        return payload.result as T;
      }

      throw new BridgeError(RpcErrorCode.InvalidRequest, "The host returned an unrecognised envelope");
    } catch (cause) {
      if (cause instanceof BridgeError) throw cause;
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new BridgeError(
          RpcErrorCode.ToolTimeout,
          `The host did not answer \`${method}\` within ${timeoutMs} ms`,
        );
      }
      throw new BridgeError(
        RpcErrorCode.HostUnavailable,
        `The request to the bridge host failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends a notification.
   *
   * The HTTP transport has no server-push channel, so a notification is
   * delivered as a fire-and-forget request. The host's reply is discarded.
   */
  override notify(method: string, params?: unknown): void {
    void this.request(method, params, 10_000).catch(() => {
      // A notification has no caller waiting on it.
    });
  }

  /** Unused: HTTP has no persistent socket to write to. */
  override send(): void {
    // Intentionally empty; see the `request` override.
  }

  override close(): void {
    this.failAll("Transport closed");
  }
}

/**
 * Chrome native messaging transport.
 *
 * Messages are length-prefixed JSON over the port's stdin/stdout. Chrome
 * delivers them already de-framed, but the *host* writes frames, and the port
 * delivers them as parsed objects — so framing is only needed on the way out.
 */
export class NativeTransport extends BaseTransport {
  readonly kind = "native" as const;

  #port: chrome.runtime.Port;
  #decoder = new NativeMessageDecoder();

  private constructor(port: chrome.runtime.Port, events: TransportEvents) {
    super(events);
    this.#port = port;

    this.#port.onMessage.addListener((message: unknown) => {
      // Chrome hands us the decoded payload; re-encode it so both transports
      // share one inbound path.
      try {
        this.handleMessage(JSON.stringify(message));
      } catch {
        // A malformed payload is dropped rather than killing the port.
      }
    });

    this.#port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message ?? "The native host disconnected";
      this.failAll(error);
      this.events.onDisconnect(error);
    });
  }

  /** Connects to the native host, or throws when it is not installed. */
  static connect(events: TransportEvents): NativeTransport {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (cause) {
      throw new BridgeError(
        RpcErrorCode.HostUnavailable,
        `Could not launch the native host \`${NATIVE_HOST_NAME}\`. Is it installed? (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }

    if (chrome.runtime.lastError) {
      throw new BridgeError(
        RpcErrorCode.HostUnavailable,
        chrome.runtime.lastError.message ?? "Native host connection failed",
      );
    }

    return new NativeTransport(port, events);
  }

  /**
   * Sends one message.
   *
   * `postMessage` takes the object and Chrome frames it, so the explicit
   * encoder is used only to enforce the size cap and to fail early on a payload
   * that is not JSON-serialisable.
   */
  override send(payload: string): void {
    // Validate size the same way the host does, so an oversized request fails
    // here with a clear error rather than being dropped by the browser.
    encodeNativeMessage(JSON.parse(payload));
    this.#port.postMessage(JSON.parse(payload));
  }

  override close(): void {
    this.failAll("Transport closed");
    try {
      this.#port.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  /** Exposed for tests that drive the decoder directly. */
  get decoder(): NativeMessageDecoder {
    return this.#decoder;
  }
}

/**
 * Loopback WebSocket transport.
 *
 * The host binds `127.0.0.1` only, so the socket is not reachable from the LAN,
 * but any local process can still connect — which is why the handshake requires
 * the shared secret.
 */
export class WebSocketTransport extends BaseTransport {
  readonly kind = "websocket" as const;

  #socket: WebSocket;

  private constructor(socket: WebSocket, events: TransportEvents) {
    super(events);
    this.#socket = socket;

    this.#socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handleMessage(event.data);
    });

    this.#socket.addEventListener("close", () => {
      this.failAll("The WebSocket to the bridge host closed");
      this.events.onDisconnect("The WebSocket to the bridge host closed");
    });

    this.#socket.addEventListener("error", () => {
      // The close event carries the actionable information; this listener only
      // prevents an unhandled error from surfacing in the console.
    });
  }

  /** Opens a connection, resolving once the socket is ready. */
  static connect(
    events: TransportEvents,
    port = DEFAULT_WEBSOCKET_PORT,
    timeoutMs = 5000,
  ): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${port}`);
      } catch (cause) {
        reject(
          new BridgeError(
            RpcErrorCode.HostUnavailable,
            `Could not open ws://127.0.0.1:${port} (${
              cause instanceof Error ? cause.message : String(cause)
            })`,
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        socket.close();
        reject(
          new BridgeError(
            RpcErrorCode.HostUnavailable,
            `Timed out connecting to ws://127.0.0.1:${port}. Is the bridge host running?`,
          ),
        );
      }, timeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new WebSocketTransport(socket, events));
      });

      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(
          new BridgeError(
            RpcErrorCode.HostUnavailable,
            `Could not connect to ws://127.0.0.1:${port}. Is the bridge host running?`,
          ),
        );
      });
    });
  }

  override send(payload: string): void {
    this.#socket.send(payload);
  }

  override close(): void {
    this.failAll("Transport closed");
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Builds the failure envelope used when a request cannot be answered. */
export function failureFor(id: number | string | null, error: unknown): JsonRpcFailure {
  const bridgeError = BridgeError.from(error);
  return { jsonrpc: "2.0", id: id as number, error: bridgeError.toErrorObject() };
}
