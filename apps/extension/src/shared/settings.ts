/**
 * Extension settings, persisted in `chrome.storage.local`.
 *
 * Stored in the extension's own storage rather than `localStorage` so the page
 * can never read or tamper with the bridge configuration — including the shared
 * secret.
 */

import { DEFAULT_WEBSOCKET_PORT, type TransportKind } from "../background/transport.js";

export interface Settings {
  /** Master switch. When false, the page is left completely untouched. */
  enabled: boolean;
  /** Which transport to use. */
  transport: TransportKind;
  /** Loopback port for the HTTP and WebSocket transports. */
  websocketPort: number;
  /** Shared secret for the HTTP and WebSocket transports. */
  secret: string;
  /**
   * Route A: inject a native `tools` parameter alongside the prompt.
   *
   * Off by default and expected to stay off: the DeepSeek web backend silently
   * ignores `tools` — there is no `tools` key in the upstream request shape at
   * all — so this only wastes tokens. It is kept as a switch only because the
   * upstream behaviour could change.
   */
  nativeToolsMode: boolean;
  /** Language for the injected instructions. */
  locale: "zh" | "en";
  /** Whether to show an in-page indicator while a tool runs. */
  showIndicator: boolean;
  /** Tool names the user has disabled in the popup. */
  disabledTools: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  // HTTP is the default: Chrome exempts extension service workers from Local
  // Network Access, and request/response lets the MV3 worker sleep. See the
  // `HttpTransport` doc comment for the full reasoning.
  transport: "http",
  websocketPort: DEFAULT_WEBSOCKET_PORT,
  secret: "",
  // Left off deliberately: see the `nativeToolsMode` comment above.
  nativeToolsMode: false,
  locale: "zh",
  showIndicator: true,
  disabledTools: [],
};

/** Reads settings, filling in any field that is missing or the wrong type. */
export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  const raw = (stored["settings"] ?? {}) as Partial<Settings>;

  const transport: TransportKind =
    raw.transport === "websocket" || raw.transport === "native" || raw.transport === "http"
      ? raw.transport
      : DEFAULT_SETTINGS.transport;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    transport,
    websocketPort:
      typeof raw.websocketPort === "number" && raw.websocketPort > 0 && raw.websocketPort < 65536
        ? raw.websocketPort
        : DEFAULT_SETTINGS.websocketPort,
    secret: typeof raw.secret === "string" ? raw.secret : "",
    nativeToolsMode:
      typeof raw.nativeToolsMode === "boolean" ? raw.nativeToolsMode : DEFAULT_SETTINGS.nativeToolsMode,
    locale: raw.locale === "en" ? "en" : "zh",
    showIndicator:
      typeof raw.showIndicator === "boolean" ? raw.showIndicator : DEFAULT_SETTINGS.showIndicator,
    disabledTools: Array.isArray(raw.disabledTools)
      ? raw.disabledTools.filter((name): name is string => typeof name === "string")
      : [],
  };
}

/** Merges a partial update into the stored settings. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Subscribes to settings changes. */
export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !changes["settings"]) return;
    const value = changes["settings"].newValue as Partial<Settings> | undefined;
    if (!value) return;
    void loadSettings().then(listener);
  };

  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
