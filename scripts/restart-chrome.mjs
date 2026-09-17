#!/usr/bin/env node
/**
 * Restarts the project's debug Chrome and re-loads the unpacked extension.
 *
 * ## Why this is needed
 *
 * A rebuilt extension cannot be picked up by refreshing the page: the content
 * script is read once, when the extension loads. The obvious fix —
 * `chrome.runtime.reload()` — is a trap in Chrome 153: it can leave a non-Web
 * Store unpacked extension **disabled**, and the extensions page then refuses to
 * re-enable it (`#card.disabled`, toggle inert, `Extensions.loadUnpacked`
 * still returning the id). The only reliable route back is a browser restart.
 *
 * ## What it does
 *
 * 1. Captures the running browser's own launch arguments, so the restart is
 *    byte-identical rather than an approximation (`--user-data-dir` and
 *    `--enable-unsafe-extension-debugging` are both load-bearing).
 * 2. Asks Chrome to close itself over CDP — a clean shutdown, so the profile is
 *    written and the session is restored, not a process kill.
 * 3. Relaunches with those arguments, waits for the debug port, and loads the
 *    unpacked extension from `apps/extension/dist`.
 *
 * Usage: node scripts/restart-chrome.mjs
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
const PORT = Number(process.env["CDP_PORT"] ?? 9222);
const extensionPath = resolve(process.argv[2] ?? "apps/extension/dist");

/** Reads the browser process's own command line, so the relaunch matches it. */
async function launchCommandLine() {
  if (process.platform !== "win32") return null;

  const { stdout } = await run("powershell", [
    "-NoProfile",
    "-Command",
    'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*--remote-debugging-port*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object -ExpandProperty CommandLine',
  ]);

  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;

  // Split on quotes while keeping quoted arguments intact.
  const parts = line.match(/"[^"]*"|\S+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ""));
}

/** True once the debug port answers. */
async function debugPortAlive() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

/** Closes the browser cleanly, over CDP. */
async function closeBrowser() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
  socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await debugPortAlive())) return true;
  }
  return false;
}

/** Loads the unpacked extension through the browser-level CDP endpoint. */
async function loadExtension() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve));

  const result = await new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    socket.send(
      JSON.stringify({ id: nextId, method: "Extensions.loadUnpacked", params: { path: extensionPath } }),
    );
  });
  socket.close();
  return result;
}

const commandLine = await launchCommandLine();
if (commandLine) {
  console.log(`closing Chrome: ${commandLine[0]}`);
  const closed = await closeBrowser();
  console.log(closed ? "  closed cleanly" : "  warning: port still answering after 15s");
} else {
  console.log("no running debug Chrome found; starting a new one");
}

// Wait for the profile lock to be released before relaunching.
await new Promise((resolve) => setTimeout(resolve, 1500));

const [executable, ...args] = commandLine ?? [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  `--remote-debugging-port=${PORT}`,
  "--enable-unsafe-extension-debugging",
  "--no-first-run",
  "--no-default-browser-check",
  "https://chat.deepseek.com/",
];

const child = spawn(executable, args, { detached: true, stdio: "ignore" });
child.unref();
console.log(`relaunched: ${executable}`);

let up = false;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (await debugPortAlive()) {
    up = true;
    break;
  }
}

if (!up) {
  console.error("Chrome did not open its debug port");
  process.exit(1);
}

// The extensions subsystem needs a moment after the port opens.
await new Promise((resolve) => setTimeout(resolve, 1500));

try {
  const loaded = await loadExtension();
  console.log(`loaded extension: ${loaded.id}`);
} catch (error) {
  console.error(`Extensions.loadUnpacked failed: ${error.message}`);
  process.exitCode = 1;
}
