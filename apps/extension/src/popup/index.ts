/**
 * The popup UI.
 *
 * A plain DOM script rather than a framework: the popup is a few hundred lines
 * of controls, and MV3 popups are torn down on every close, so there is no
 * component state worth preserving and no benefit to a virtual DOM.
 *
 * All mutations go through `chrome.storage`, and the background worker reacts to
 * those changes — the popup never talks to the host directly.
 */

import type { ToolDescriptor } from "@dlb/protocol";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "../shared/settings.js";
import type { WorkerRequest, WorkerResponse } from "../background/index.js";

/** Sends a message to the service worker. */
async function ask(request: WorkerRequest): Promise<WorkerResponse> {
  return (await chrome.runtime.sendMessage(request)) as WorkerResponse;
}

/** Looks up a required element, failing loudly if the markup drifted. */
function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`popup is missing #${id}`);
  return element as T;
}

const ui = {
  dot: need<HTMLSpanElement>("status-dot"),
  statusText: need<HTMLParagraphElement>("status-text"),
  enabled: need<HTMLInputElement>("enabled"),
  wsSettings: need<HTMLElement>("ws-settings"),
  port: need<HTMLInputElement>("port"),
  secret: need<HTMLInputElement>("secret"),
  tools: need<HTMLUListElement>("tools"),
  reconnect: need<HTMLButtonElement>("reconnect"),
  version: need<HTMLSpanElement>("version"),
};

let settings: Settings = DEFAULT_SETTINGS;

/** Renders the connection indicator and message. */
function renderStatus(state: "connected" | "error" | "unknown", message: string): void {
  ui.dot.dataset["state"] = state;
  ui.dot.title = message;
  ui.statusText.textContent = message;
}

/** Renders the tool list with a checkbox per tool. */
function renderTools(tools: ToolDescriptor[], disabled: string[]): void {
  ui.tools.replaceChildren();

  if (tools.length === 0) {
    const item = document.createElement("li");
    item.className = "placeholder";
    item.textContent = "没有可用工具。请确认本地桥接程序正在运行。";
    ui.tools.appendChild(item);
    return;
  }

  const disabledSet = new Set(disabled);

  for (const tool of tools) {
    const item = document.createElement("li");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !disabledSet.has(tool.name);
    checkbox.id = `tool-${tool.name}`;
    checkbox.addEventListener("change", () => {
      void toggleTool(tool.name, checkbox.checked);
    });

    const body = document.createElement("div");
    body.className = "tool-body";

    const name = document.createElement("label");
    name.className = "tool-name";
    name.htmlFor = checkbox.id;
    name.textContent = tool.name;

    // A mutating tool is flagged, because it is the one that can destroy work.
    if (tool.mutating) {
      const badge = document.createElement("span");
      badge.className = "tool-badge";
      badge.textContent = "会修改";
      name.appendChild(badge);
    }

    const summary = document.createElement("span");
    summary.className = "tool-summary";
    summary.textContent = tool.summary;

    body.append(name, summary);
    item.append(checkbox, body);
    ui.tools.appendChild(item);
  }
}

/** Persists a tool enable/disable toggle. */
async function toggleTool(name: string, enabled: boolean): Promise<void> {
  const next = new Set(settings.disabledTools);
  if (enabled) next.delete(name);
  else next.add(name);

  settings = await saveSettings({ disabledTools: [...next] });
}

/** Reflects the transport choice in the form. */
function renderTransport(): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="transport"]')) {
    radio.checked = radio.value === settings.transport;
  }
  // Only the loopback transports take a port and token; native messaging is
  // addressed by host name and authenticated by Chrome itself.
  ui.wsSettings.hidden = settings.transport === "native";
}

/** Reflects the locale choice in the form. */
function renderLocale(): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="locale"]')) {
    radio.checked = radio.value === settings.locale;
  }
}

/** Refreshes the status line and tool list from the worker. */
async function refresh(): Promise<void> {
  try {
    const statusResponse = await ask({ kind: "status" });
    if (statusResponse.kind !== "status") return;

    const { status } = statusResponse;
    if (status.connected) {
      renderStatus(
        "connected",
        `已连接（${status.kind === "native" ? "Native Messaging" : "WebSocket"}` +
          `${status.hostVersion ? ` · 宿主 v${status.hostVersion}` : ""}` +
          `${status.platform ? ` · ${status.platform}` : ""}）`,
      );

      const toolsResponse = await ask({ kind: "tools" });
      if (toolsResponse.kind === "tools") {
        renderTools(toolsResponse.tools, settings.disabledTools);
      }
    } else {
      renderStatus("error", status.error ?? "未连接到本地桥接程序");
      renderTools([], []);
    }
  } catch (cause) {
    renderStatus("error", cause instanceof Error ? cause.message : String(cause));
    renderTools([], []);
  }
}

// --- wiring ---------------------------------------------------------------

ui.enabled.addEventListener("change", () => {
  void saveSettings({ enabled: ui.enabled.checked });
});

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="transport"]')) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    settings = { ...settings, transport: radio.value as Settings["transport"] };
    renderTransport();
    void saveSettings({ transport: settings.transport });
  });
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="locale"]')) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    settings = { ...settings, locale: radio.value as Settings["locale"] };
    void saveSettings({ locale: settings.locale });
  });
}

// Text inputs are debounced: a port typed digit by digit should not trigger a
// reconnect on every keystroke.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const port = Number.parseInt(ui.port.value, 10);
    void saveSettings({
      websocketPort: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_SETTINGS.websocketPort,
      secret: ui.secret.value.trim(),
    });
  }, 500);
}

ui.port.addEventListener("input", scheduleSave);
ui.secret.addEventListener("input", scheduleSave);

ui.reconnect.addEventListener("click", () => {
  ui.reconnect.disabled = true;
  renderStatus("unknown", "正在重新连接…");
  void ask({ kind: "disconnect" })
    .then(() => ask({ kind: "connect" }))
    .then(() => refresh())
    .finally(() => {
      ui.reconnect.disabled = false;
    });
});

// --- bootstrap ------------------------------------------------------------

void (async () => {
  settings = await loadSettings();

  ui.version.textContent = `v${chrome.runtime.getManifest().version}`;
  ui.enabled.checked = settings.enabled;
  ui.port.value = String(settings.websocketPort);
  ui.secret.value = settings.secret;
  renderTransport();
  renderLocale();

  await refresh();
})();
