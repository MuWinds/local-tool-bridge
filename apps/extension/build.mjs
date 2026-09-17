/**
 * Build script for the MV3 extension.
 *
 * esbuild rather than a full bundler because an extension has four independent
 * entry points with different target environments (MAIN world page context,
 * ISOLATED content script, service worker, popup) and no HTML entry to drive a
 * dev server from. esbuild expresses that directly and builds in milliseconds.
 *
 * The MAIN world script is emitted as a classic IIFE: it runs in the page's own
 * context, where an ES module would not have the global `window` bindings the
 * fetch hook needs to patch.
 */

import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, "dist");
const watch = process.argv.includes("--watch");
const zip = process.argv.includes("--zip");

/** Shared options for every entry point. */
const shared = {
  bundle: true,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  target: ["chrome116"],
  logLevel: "info",
  // The protocol package is a workspace dependency resolved from source, so a
  // stale `dist` cannot silently ship a different wire format than the host.
  alias: {
    "@dlb/protocol": resolve(here, "../..", "packages/protocol/src/index.ts"),
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
  },
};

/** One build per entry point, each with its own output format. */
const targets = [
  {
    entryPoints: [resolve(here, "src/main-world/index.ts")],
    outfile: resolve(outdir, "main-world.js"),
    // Classic script: this runs in the page, not in an extension context.
    format: "iife",
    platform: "browser",
  },
  {
    entryPoints: [resolve(here, "src/content/index.ts")],
    outfile: resolve(outdir, "content.js"),
    format: "iife",
    platform: "browser",
  },
  {
    entryPoints: [resolve(here, "src/background/index.ts")],
    outfile: resolve(outdir, "background.js"),
    format: "esm",
    platform: "browser",
  },
  {
    entryPoints: [resolve(here, "src/popup/index.ts")],
    outfile: resolve(outdir, "popup.js"),
    format: "iife",
    platform: "browser",
  },
];

/** Copies the static assets that esbuild does not process. */
async function copyStatic() {
  await cp(resolve(here, "src/manifest.json"), resolve(outdir, "manifest.json"));
  await cp(resolve(here, "src/popup/popup.html"), resolve(outdir, "popup.html"));
  await cp(resolve(here, "src/popup/popup.css"), resolve(outdir, "popup.css"));

  const icons = resolve(here, "src/icons");
  if (existsSync(icons)) {
    await cp(icons, resolve(outdir, "icons"), { recursive: true });
  }
}

/** Rewrites the manifest to declare the icons that actually exist. */
async function finalizeManifest() {
  const manifestPath = resolve(outdir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  const iconPath = resolve(outdir, "icons/icon128.png");
  if (!existsSync(iconPath)) {
    // Shipping a manifest that references missing icons makes Chrome refuse to
    // load the extension, so the icon block is dropped when none were built.
    delete manifest.icons;
    delete manifest.action.default_icon;
  } else {
    manifest.icons = {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    };
    manifest.action.default_icon = manifest.icons;
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Produces a loadable zip in `release/`. */
async function makeZip() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const releaseDir = resolve(here, "../../release");
  await mkdir(releaseDir, { recursive: true });
  const archive = resolve(releaseDir, "local-tool-bridge-extension.zip");

  // PowerShell's Compress-Archive is present on every supported Windows, and
  // `zip` covers macOS and Linux.
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${outdir}\\*' -DestinationPath '${archive}' -Force`,
    ]);
  } else {
    await run("zip", ["-r", "-q", archive, "."], { cwd: outdir });
  }
  console.log(`\nPackaged extension -> ${archive}`);
}

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    // Watch mode rebuilds every target on change; esbuild keeps the contexts
    // alive until the process is interrupted.
    for (const target of targets) {
      const ctx = await context({ ...shared, ...target });
      await ctx.watch();
    }
    console.log("watching for changes...");
    return;
  }

  await Promise.all(targets.map((target) => build({ ...shared, ...target })));
  await copyStatic();
  await finalizeManifest();

  console.log(`\nBuilt extension -> ${outdir}`);
  if (zip) await makeZip();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
