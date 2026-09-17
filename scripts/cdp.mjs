#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol client.
 *
 * The chrome-devtools MCP only surfaces page targets, but this test needs to
 * evaluate code inside the extension's *service worker* — that is where the
 * bridge connection lives and where the injected prompt is assembled.
 *
 * Node 22 ships a global WebSocket, so no dependency is needed.
 *
 * Usage:
 *   node scripts/cdp.mjs list
 *   node scripts/cdp.mjs eval <target-substring> <js-expression>
 *   node scripts/cdp.mjs targets
 */

const DEBUG_PORT = Number(process.env["CDP_PORT"] ?? 9222);

/** Fetches the CDP target list. */
async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return response.json();
}

/** Finds the first target whose URL contains `needle`. */
async function findTarget(needle) {
  const targets = await listTargets();
  return targets.find((target) => (target.url ?? "").includes(needle)) ?? null;
}

/** Opens a CDP session and evaluates one expression, returning its value. */
async function evaluate(target, expression, { awaitPromise = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("CDP evaluation timed out"));
    }, 30_000);

    let messageId = 0;

    socket.addEventListener("open", () => {
      messageId += 1;
      socket.send(
        JSON.stringify({
          id: messageId,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise,
            returnByValue: true,
            // The service worker has no user gesture; this keeps APIs like
            // clipboard and storage usable in an automated context.
            userGesture: true,
          },
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id !== messageId) return;

      clearTimeout(timer);
      socket.close();

      if (payload.error) {
        reject(new Error(`CDP error: ${JSON.stringify(payload.error)}`));
        return;
      }
      const result = payload.result?.result;
      if (payload.result?.exceptionDetails) {
        reject(
          new Error(
            `Evaluation threw: ${
              payload.result.exceptionDetails.exception?.description ??
              payload.result.exceptionDetails.text
            }`,
          ),
        );
        return;
      }
      resolve(result?.value);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP socket error"));
    });
  });
}

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "targets" || command === "list") {
    const targets = await listTargets();
    for (const target of targets) {
      console.log(`${(target.type ?? "").padEnd(18)} ${(target.title ?? "").slice(0, 44).padEnd(46)} ${target.url}`);
    }
  } else if (command === "eval") {
    const [needle, ...expressionParts] = rest;
    const expression = expressionParts.join(" ");
    if (!needle || !expression) {
      console.error("usage: cdp.mjs eval <target-substring> <js-expression>");
      process.exit(2);
    }

    const target = await findTarget(needle);
    if (!target) {
      console.error(`no CDP target matching "${needle}"`);
      process.exit(1);
    }

    const value = await evaluate(target, expression);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } else {
    console.error("usage: cdp.mjs <list|targets|eval>");
    process.exit(2);
  }
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(1);
}
