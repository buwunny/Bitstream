/**
 * circuit-webview.ts
 * ----------------------------------------------------------------------------
 * Webview HTML scaffolding for the circuit editor.
 *
 * The front-end source lives in webview-src/circuit-editor/ and compiles via
 * esbuild to out/webview/circuit-editor.js. This file is just the HTML host:
 * it mints a webview-safe URI for the bundle, injects the gate-SVG URI map as
 * a small inline script, and lets the bundled module take it from there.
 */

import * as vscode from "vscode";

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

/**
 * Build the webview HTML. The panel is needed to mint webview-safe URIs for
 * the gate SVGs and the bundled script; the extensionUri locates the on-disk
 * media and out folders.
 */
export function renderCircuitHtml(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): string {
  const gateNames = ["and", "or", "xor", "nand", "nor", "xnor", "not", "buf", "dff", "input", "output"] as const;
  const gateUris: Record<string, string> = {};
  for (const name of gateNames) {
    const uri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "gates", `${name}.svg`),
    );
    gateUris[name.toUpperCase()] = uri.toString();
  }

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "out", "webview", "circuit-editor.js"),
  );

  const nonce = randomNonce();
  // Bundle loads from panel.webview.cspSource; the small inline shim that
  // injects window.GATE_URIS still requires the nonce.
  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${panel.webview.cspSource}`,
    `img-src ${panel.webview.cspSource} data:`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Circuit Editor</title>
<style>
  html, body { height: 100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
  .root { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
  .toolbar { display: flex; gap: 0.5rem; padding: 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; flex-wrap: wrap; }
  .toolbar input[type="text"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 0.25rem 0.5rem; }
  .toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 0.3rem 0.7rem; cursor: pointer; }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  .toolbar button.ghost { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  .toolbar .spacer { flex: 1; }
  .toolbar .status { opacity: 0.7; font-size: 0.85rem; min-width: 8em; }
  .body { display: grid; grid-template-columns: 180px 1fr; min-height: 0; }
  .palette { border-right: 1px solid var(--vscode-panel-border); padding: 0.5rem; overflow-y: auto; }
  .palette h3 { font-size: 0.75rem; opacity: 0.7; margin: 0.75rem 0 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .palette-section h3.palette-header { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; padding: 0.15rem 0.1rem; border-radius: 2px; }
  .palette-section h3.palette-header:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04)); opacity: 0.9; }
  .palette-section .chevron { font-size: 0.7rem; transition: transform 0.15s; display: inline-block; opacity: 0.7; }
  .palette-section.collapsed .chevron { transform: rotate(-90deg); }
  .palette-section.collapsed .palette-content { display: none; }
  .palette .item { padding: 0.4rem 0.5rem; margin: 0.15rem 0; background: var(--vscode-editor-inactiveSelectionBackground); cursor: grab; user-select: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85rem; border-radius: 2px; display: flex; justify-content: space-between; align-items: center; }
  .palette .item .badge { opacity: 0.5; font-size: 0.7rem; }
  .palette .item:active { cursor: grabbing; }
  .palette button.add { width: 100%; margin-top: 0.25rem; background: transparent; color: var(--vscode-foreground); border: 1px dashed var(--vscode-panel-border); padding: 0.3rem; cursor: pointer; font-size: 0.8rem; }
  .canvas-wrap { position: relative; overflow: hidden; }
  svg.canvas { width: 100%; height: 100%; background:
    linear-gradient(var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.02)) 1px, transparent 1px) 0 0 / 20px 20px,
    linear-gradient(90deg, var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.02)) 1px, transparent 1px) 0 0 / 20px 20px;
  }
  svg.canvas.panning { cursor: grabbing; }
  svg.canvas.spacing  { cursor: grab; }
  .node rect:not(.hit):not(.node-tint) { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); stroke-width: 1.2; }
  .node.module rect:not(.node-tint) { fill: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background)); }
  .node.has-color rect:not(.hit):not(.node-tint) { fill: var(--node-color); }
  .node .node-tint { fill: transparent; stroke: none; pointer-events: none; }
  .node.has-color .node-tint { fill: var(--node-color); fill-opacity: 0.35; stroke: var(--node-color); stroke-width: 1.5; }
  .node.selected rect:not(.hit):not(.node-tint) { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .node .hit { fill: transparent; stroke: none; }
  .node.selected .hit { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  body.vscode-dark image, body.vscode-high-contrast image { filter: invert(1); }
  .node text.label { fill: var(--vscode-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; text-anchor: middle; pointer-events: none; }
  .node text.type  { fill: var(--vscode-descriptionForeground); font-size: 9px; text-anchor: middle; pointer-events: none; }
  .node text.pin-label { fill: var(--vscode-descriptionForeground); font-size: 9px; pointer-events: none; }
  .pin { fill: var(--vscode-editor-background); stroke: var(--vscode-foreground); stroke-width: 1; cursor: crosshair; }
  .pin.bus { stroke-width: 2.2; }
  .pin:hover { fill: var(--vscode-focusBorder); }
  .wire { fill: none; stroke: var(--vscode-charts-blue, #6ab0f3); stroke-width: 2; }
  .wire.has-color { stroke: var(--wire-color); }
  .wire.bus { stroke-width: 3.5; }
  .wire.selected { stroke: var(--vscode-focusBorder); }
  .wire.pending { stroke-dasharray: 4 4; opacity: 0.7; }
  .junction { fill: var(--vscode-charts-blue, #6ab0f3); stroke: none; pointer-events: none; }
  .waypoint { fill: var(--vscode-editor-background); stroke: var(--vscode-focusBorder); stroke-width: 1.5; cursor: move; }
  .waypoint:hover { fill: var(--vscode-focusBorder); }
  .waypoint.ghost { opacity: 0.5; stroke-dasharray: 2 2; }
  .waypoint.ghost:hover { opacity: 1; stroke-dasharray: none; }
  .color-control { display: inline-flex; align-items: center; gap: 0.25rem; }
  .color-control input[type="color"] { width: 28px; height: 22px; border: 1px solid var(--vscode-panel-border); background: transparent; padding: 0; cursor: pointer; }
  .wire-label { fill: var(--vscode-descriptionForeground); font-size: 9px; pointer-events: none; }
  .rubber { fill: var(--vscode-focusBorder); fill-opacity: 0.08; stroke: var(--vscode-focusBorder); stroke-dasharray: 3 3; }
  .hint { position: absolute; bottom: 0.5rem; left: 0.5rem; opacity: 0.55; font-size: 0.75rem; pointer-events: none; }
  .footer { padding: 0.3rem 0.6rem; font-size: 0.75rem; opacity: 0.6; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 1rem; }
</style>
</head>
<body>
<div class="root">
  <div class="toolbar">
    <button id="btnNew">New</button>
    <button id="btnOpen">Open…</button>
    <button id="btnSave">Save</button>
    <button id="btnSaveAs">Save As…</button>
    <button id="btnExport" title="Export to Verilog, SystemVerilog, or VHDL">Export HDL…</button>
    <button id="btnUndo" class="ghost" title="Ctrl/Cmd+Z">Undo</button>
    <button id="btnRedo" class="ghost" title="Ctrl/Cmd+Shift+Z">Redo</button>
    <button id="btnRouting" class="ghost" title="Cycle wire mode: curved → straight → right-angle. Straight and right-angle modes support routing waypoints; right-angle also forces every segment to be axis-aligned.">Wires: curved</button>
    <button id="btnSnap" class="ghost" title="Snap node placement, drags, and wire waypoints to the visible grid.">Snap: on</button>
    <label class="color-control" title="Color of the current selection (nodes or wire)"><input id="colorPicker" type="color" value="#6ab0f3" /></label>
    <button id="btnClearColor" class="ghost" title="Remove color override from selection">Clear color</button>
    <span class="spacer"></span>
    <label>Module: <input id="moduleName" type="text" value="circuit" size="20" /></label>
    <span class="status" id="status"></span>
  </div>
  <div class="body">
    <div class="palette" id="palette">
      <div class="palette-section" data-section="io">
        <h3 class="palette-header">I/O <span class="chevron">▾</span></h3>
        <div class="palette-content">
          <div class="item" draggable="true" data-type="INPUT">INPUT</div>
          <div class="item" draggable="true" data-type="OUTPUT">OUTPUT</div>
        </div>
      </div>
      <div class="palette-section" data-section="gates">
        <h3 class="palette-header">Gates <span class="chevron">▾</span></h3>
        <div class="palette-content">
          <div class="item" draggable="true" data-type="AND">AND</div>
          <div class="item" draggable="true" data-type="OR">OR</div>
          <div class="item" draggable="true" data-type="XOR">XOR</div>
          <div class="item" draggable="true" data-type="NAND">NAND</div>
          <div class="item" draggable="true" data-type="NOR">NOR</div>
          <div class="item" draggable="true" data-type="XNOR">XNOR</div>
          <div class="item" draggable="true" data-type="NOT">NOT</div>
          <div class="item" draggable="true" data-type="BUF">BUF</div>
        </div>
      </div>
      <div class="palette-section" data-section="sequential">
        <h3 class="palette-header">Sequential <span class="chevron">▾</span></h3>
        <div class="palette-content">
          <div class="item" draggable="true" data-type="DFF">DFF</div>
        </div>
      </div>
      <div class="palette-section" data-section="modules">
        <h3 class="palette-header">Modules <span class="chevron">▾</span></h3>
        <div class="palette-content">
          <div id="moduleList"></div>
          <button class="add" id="btnImportModule">+ Import Circuit Module…</button>
          <button class="add" id="btnImportHdl" title="Import a Verilog/SystemVerilog module as a component">+ Import HDL Module…</button>
          <button class="add" id="btnReloadModules" title="Re-read every imported module from its source file">⟳ Reload from disk</button>
        </div>
      </div>
    </div>
    <div class="canvas-wrap">
      <svg class="canvas" id="canvas" xmlns="http://www.w3.org/2000/svg">
        <g id="viewport"></g>
      </svg>
    </div>
  </div>
  <div class="footer">
    <span id="footer">Untitled</span>
    <span id="zoomLabel">100%</span>
  </div>
</div>

<script nonce="${nonce}">window.GATE_URIS = ${JSON.stringify(gateUris)};</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
