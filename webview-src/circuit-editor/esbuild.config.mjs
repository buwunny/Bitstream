// Build script for the circuit-editor webview bundle.
//
// Emits a single IIFE-wrapped JS file at out/webview/circuit-editor.js
// relative to the extension repo root. The extension host serves it through
// panel.webview.asWebviewUri() — see src/editors/circuit_editor/circuit-webview.ts.

import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [path.join(__dirname, "src", "main.ts")],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  platform: "browser",
  outfile: path.join(repoRoot, "out", "webview", "circuit-editor.js"),
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[circuit-editor webview] watching for changes…");
} else {
  await esbuild.build(options);
}
