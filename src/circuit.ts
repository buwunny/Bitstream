/**
 * circuit.ts
 * ----------------------------------------------------------------------------
 * Prototype graphical circuit editor (webview).
 *
 * The host (this file) owns:
 *   • file IO for the `.bscircuit.json` document model
 *   • module-interface import (reading another circuit's INPUT/OUTPUT pins)
 *   • Verilog netlist export (gates, sequential, hierarchical modules, buses)
 *
 * The webview (WEBVIEW_SCRIPT at the bottom) owns:
 *   • rendering (SVG with pan/zoom via a single content <g> transform)
 *   • selection model: a Set of node ids + at most one wire selection
 *   • interactions: drag-place, drag-move, wire draw, box-select,
 *     copy/paste, undo/redo, double-click rename
 *
 * Webview ↔ host protocol:
 *     ws -> { type: "save",          payload: CircuitDoc, asNew?: boolean }
 *     ws -> { type: "open" }
 *     ws -> { type: "exportVerilog", payload: CircuitDoc }
 *     ws -> { type: "importModule" }
 *     ws -> { type: "dirty",         payload: boolean }
 *     ho -> { type: "loaded",        payload: CircuitDoc, path: string }
 *     ho -> { type: "saved",         path: string }
 *     ho -> { type: "moduleImported", name, iface }
 *     ho -> { type: "info" | "error", message: string }
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { parseVerilogText, parseVhdlText, ModuleDecl } from "./hierarchy";

type PinSide = "in" | "out";

export type NodeType =
  | "INPUT" | "OUTPUT"
  | "AND" | "OR" | "XOR" | "NAND" | "NOR" | "XNOR"
  | "NOT" | "BUF"
  | "DFF"
  | "MODULE";

export interface ModulePort { label: string; width: number; }

/** HDL flavour for imports and exports. */
export type HdlLanguage = "verilog" | "systemverilog" | "vhdl";

export interface ModuleInterface {
  ins: ModulePort[];
  outs: ModulePort[];
  /** Relative path the module was imported from — kept for drill-down and reload. */
  file?: string;
  /**
   * Full body of the referenced design. We snapshot it at import time so the
   * file is self-contained: Verilog export can emit the whole hierarchy
   * without re-reading anything from disk, and offline editing keeps
   * working. A separate "Reload Modules" action picks up external changes.
   */
  body?: CircuitDoc;
  /**
   * Raw HDL source for imported leaf modules. When set the module is a leaf
   * — export emits this text verbatim instead of synthesising from `body`.
   * `language` tags the source flavour so cross-language exports can decide
   * to inline (matching language) or skip (mismatched) on a per-import basis.
   */
  hdlSource?: string;
  language?: HdlLanguage;
}

export interface CircuitNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  label: string;
  /** Present when type === "MODULE" — key into doc.modules. */
  moduleRef?: string;
  /** Optional CSS color string overriding the default node fill/outline. */
  color?: string;
}

export interface CircuitWire {
  from: { id: string; pin: number; side: PinSide };
  to: { id: string; pin: number; side: PinSide };
  /** Optional CSS color string overriding the default wire stroke. */
  color?: string;
  /**
   * Intermediate routing points for straight-wire layout. Each point is in
   * content-space coordinates and becomes a vertex in the polyline drawn
   * from `from` through the waypoints to `to`. Ignored in curved mode.
   */
  waypoints?: Array<{ x: number; y: number }>;
}

export type RoutingStyle = "curved" | "straight";

export interface CircuitDoc {
  moduleName: string;
  nodes: CircuitNode[];
  wires: CircuitWire[];
  /** Hierarchical module library kept inline so the file is self-contained. */
  modules?: Record<string, ModuleInterface>;
  /** Wire rendering mode. Defaults to "curved" when absent. */
  routingStyle?: RoutingStyle;
}

const FILE_EXT = ".bscircuit.json";

// ---------------------------------------------------------------------------
// Editor panel
// ---------------------------------------------------------------------------

export class CircuitEditor {
  public static readonly viewType = "bitstream.circuit";
  private static instances: CircuitEditor[] = [];

  public static show(extensionUri: vscode.Uri, openFile?: vscode.Uri): void {
    const panel = vscode.window.createWebviewPanel(
      CircuitEditor.viewType,
      "Circuit Editor",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    const editor = new CircuitEditor(panel, extensionUri);
    CircuitEditor.instances.push(editor);
    if (openFile) { editor.loadFromDisk(openFile); }
  }

  private readonly panel: vscode.WebviewPanel;
  private currentPath: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly extensionUri: vscode.Uri;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg).catch((err) => {
        this.panel.webview.postMessage({ type: "error", message: String(err?.message ?? err) });
      }),
      null, this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "save": return this.save(msg.payload as CircuitDoc, !!msg.asNew);
      case "open": return this.openDialog();
      case "exportHdl": return this.exportHdl(msg.payload as CircuitDoc);
      case "importModule": return this.importModule(msg.ownName as string | undefined);
      case "importHdlModule": return this.importHdlModule(msg.ownName as string | undefined);
      case "openModule": return this.openModuleFile(msg.file as string);
      case "reloadModules": return this.reloadModules(msg.modules as Array<{ name: string; file: string }>);
      case "dirty": this.panel.title = msg.payload ? "Circuit Editor •" : "Circuit Editor"; return;
    }
  }

  private async save(doc: CircuitDoc, asNew: boolean): Promise<void> {
    let target = this.currentPath;
    if (asNew || !target) {
      const picked = await vscode.window.showSaveDialog({
        filters: { Circuit: ["bscircuit.json", "json"] },
        defaultUri: this.suggestedSaveUri(doc),
        saveLabel: "Save Circuit",
      });
      if (!picked) { return; }
      target = picked;
    }
    fs.writeFileSync(target.fsPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    this.currentPath = target;
    this.panel.webview.postMessage({ type: "saved", path: target.fsPath });
    vscode.window.showInformationMessage(`Circuit saved: ${path.basename(target.fsPath)}`);
  }

  private suggestedSaveUri(doc: CircuitDoc): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) { return undefined; }
    return vscode.Uri.joinPath(ws, "src", `${doc.moduleName || "circuit"}${FILE_EXT}`);
  }

  private async openDialog(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: { Circuit: ["bscircuit.json", "json"] },
    });
    if (!picked || !picked[0]) { return; }
    await this.loadFromDisk(picked[0]);
  }

  private async loadFromDisk(uri: vscode.Uri): Promise<void> {
    const raw = fs.readFileSync(uri.fsPath, "utf8");
    let doc: CircuitDoc;
    try { doc = JSON.parse(raw) as CircuitDoc; }
    catch (e: any) { throw new Error(`Failed to parse circuit JSON: ${e.message}`); }
    this.currentPath = uri;
    this.panel.webview.postMessage({ type: "loaded", payload: doc, path: uri.fsPath });
  }

  /**
   * Pick a .bscircuit.json, extract its INPUT/OUTPUT ports as a
   * ModuleInterface (widths parsed from labels), snapshot its body for
   * self-contained Verilog emit + drill-down, and ship it back to the
   * webview. Refuses imports that would form a cycle.
   */
  private async importModule(ownName?: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: { Circuit: ["bscircuit.json", "json"] },
    });
    if (!picked || !picked[0]) { return; }
    const iface = this.readModuleFromDisk(picked[0].fsPath);
    const name = sanitize(iface.body?.moduleName || path.basename(picked[0].fsPath).replace(/\.[^.]+$/, ""));

    // Cycle check — a child must not (transitively) reference us.
    if (ownName && (name === sanitize(ownName) || (iface.body && referencesModule(iface.body, sanitize(ownName))))) {
      throw new Error(`Refusing to import "${name}": would form a circular dependency with "${ownName}".`);
    }
    this.panel.webview.postMessage({ type: "moduleImported", name, iface });
  }

  /**
   * Pick an HDL file (Verilog / SystemVerilog / VHDL), parse its module or
   * entity declarations, and (if more than one) prompt the user for which
   * to import. The chosen module becomes a leaf MODULE in the palette with
   * its raw HDL source snapshotted so export can emit it verbatim when the
   * output language matches.
   */
  private async importHdlModule(ownName?: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: {
        "Verilog": ["v", "vh"],
        "SystemVerilog": ["sv", "svh"],
        "VHDL": ["vhd", "vhdl"],
        "All HDL": ["v", "vh", "sv", "svh", "vhd", "vhdl"],
      },
    });
    if (!picked || !picked[0]) { return; }
    const absPath = picked[0].fsPath;
    const relPath = this.currentPath
      ? path.relative(path.dirname(this.currentPath.fsPath), absPath).split(path.sep).join("/")
      : absPath;
    const { decls, language, source } = parseHdlFile(absPath, relPath);
    if (!decls.length) {
      throw new Error(`No module declarations found in ${path.basename(absPath)}.`);
    }
    let decl = decls[0];
    if (decls.length > 1) {
      const pick = await vscode.window.showQuickPick(
        decls.map((d) => ({ label: d.name, description: `${d.ports.length} ports`, decl: d })),
        { placeHolder: "Choose a module to import" },
      );
      if (!pick) { return; }
      decl = pick.decl;
    }

    if (ownName && sanitize(decl.name) === sanitize(ownName)) {
      throw new Error(`Refusing to import "${decl.name}": same name as the current circuit.`);
    }

    const ins: ModulePort[] = [];
    const outs: ModulePort[] = [];
    for (const p of decl.ports) {
      const entry: ModulePort = { label: p.name, width: p.width };
      if (p.direction === "output") { outs.push(entry); } else { ins.push(entry); }
    }
    const iface: ModuleInterface = { ins, outs, file: relPath, hdlSource: source, language };
    this.panel.webview.postMessage({ type: "moduleImported", name: decl.name, iface });
  }

  /**
   * Read a single module file off disk and produce its ModuleInterface
   * (used by both initial import and the "Reload Modules" action). Handles
   * both .bscircuit.json sub-circuits and raw Verilog/SystemVerilog files.
   */
  private readModuleFromDisk(absPath: string, preferredName?: string): ModuleInterface {
    const relPath = this.currentPath
      ? path.relative(path.dirname(this.currentPath.fsPath), absPath).split(path.sep).join("/")
      : absPath;
    if (/\.(v|vh|sv|svh|vhd|vhdl)$/i.test(absPath)) {
      const { decls, language, source } = parseHdlFile(absPath, relPath);
      if (!decls.length) { throw new Error(`No module declarations found in ${path.basename(absPath)}.`); }
      const decl = (preferredName && decls.find((d) => d.name === preferredName)) || decls[0];
      const ins: ModulePort[] = [];
      const outs: ModulePort[] = [];
      for (const p of decl.ports) {
        const entry: ModulePort = { label: p.name, width: p.width };
        if (p.direction === "output") { outs.push(entry); } else { ins.push(entry); }
      }
      return { ins, outs, file: relPath, hdlSource: source, language };
    }
    const raw = fs.readFileSync(absPath, "utf8");
    const child = JSON.parse(raw) as CircuitDoc;
    const ins: ModulePort[] = [];
    const outs: ModulePort[] = [];
    for (const n of child.nodes) {
      if (n.type === "INPUT") { ins.push(portFromLabel(n.label)); }
      if (n.type === "OUTPUT") { outs.push(portFromLabel(n.label)); }
    }
    return { ins, outs, file: relPath, body: child };
  }

  /** Open a referenced module's source file in a new editor (drill-down). */
  private async openModuleFile(relOrAbs: string): Promise<void> {
    const abs = this.resolveModulePath(relOrAbs);
    if (!abs) { throw new Error("Save this circuit first so module paths can be resolved."); }
    if (!fs.existsSync(abs)) { throw new Error(`Module file not found: ${abs}`); }
    // HDL sources open in a normal text editor; .bscircuit.json files spawn
    // a fresh CircuitEditor via the host command.
    if (/\.(v|vh|sv|svh|vhd|vhdl)$/i.test(abs)) {
      await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
      return;
    }
    await vscode.commands.executeCommand("bitstream.openCircuit", vscode.Uri.file(abs));
  }

  /** Re-read every named module's body from disk and ship the refreshed interfaces back. */
  private async reloadModules(entries: Array<{ name: string; file: string }>): Promise<void> {
    const refreshed: Array<{ name: string; iface: ModuleInterface }> = [];
    const missing: string[] = [];
    for (const { name, file } of entries) {
      const abs = this.resolveModulePath(file);
      if (!abs || !fs.existsSync(abs)) { missing.push(name); continue; }
      refreshed.push({ name, iface: this.readModuleFromDisk(abs, name) });
    }
    this.panel.webview.postMessage({ type: "modulesReloaded", refreshed, missing });
  }

  private resolveModulePath(relOrAbs: string): string | undefined {
    if (!relOrAbs) { return undefined; }
    if (path.isAbsolute(relOrAbs)) { return relOrAbs; }
    if (!this.currentPath) { return undefined; }
    return path.resolve(path.dirname(this.currentPath.fsPath), relOrAbs);
  }

  /**
   * Prompt for the target HDL flavour, then run the language-aware emitter
   * and write the result to a user-picked path. Imports of a different
   * language than the target are listed in the result and surfaced as a
   * warning so the user knows to feed those sources to their toolchain.
   */
  private async exportHdl(doc: CircuitDoc): Promise<void> {
    type LangChoice = { label: string; description: string; lang: HdlLanguage; ext: string; filterName: string };
    const choices: LangChoice[] = [
      { label: "Verilog", description: ".v", lang: "verilog", ext: "v", filterName: "Verilog" },
      { label: "SystemVerilog", description: ".sv", lang: "systemverilog", ext: "sv", filterName: "SystemVerilog" },
      { label: "VHDL", description: ".vhd", lang: "vhdl", ext: "vhd", filterName: "VHDL" },
    ];
    const pick = await vscode.window.showQuickPick(choices, { placeHolder: "Export to which HDL?" });
    if (!pick) { return; }

    const result = generateHdl(doc, pick.lang);
    const suggested = (() => {
      const baseName = (() => {
        if (this.currentPath) {
          return path.basename(this.currentPath.fsPath).replace(/\.bscircuit\.json$|\.json$/i, "");
        }
        return doc.moduleName || "circuit";
      })();
      const dir = this.currentPath
        ? path.dirname(this.currentPath.fsPath)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!dir) { return undefined; }
      return vscode.Uri.file(path.join(dir, `${baseName}.${pick.ext}`));
    })();
    const target = await vscode.window.showSaveDialog({
      filters: { [pick.filterName]: [pick.ext] },
      defaultUri: suggested,
      saveLabel: `Export ${pick.label}`,
    });
    if (!target) { return; }
    fs.writeFileSync(target.fsPath, result.text, "utf8");
    this.panel.webview.postMessage({ type: "info", message: `Exported: ${path.basename(target.fsPath)}` });

    if (result.skipped.length) {
      const names = result.skipped.map((s) => `${s.name} (${s.language})`).join(", ");
      vscode.window.showWarningMessage(
        `Exported ${pick.label}: ${path.basename(target.fsPath)}. ` +
        `Skipped inlining ${result.skipped.length} mismatched-language module${result.skipped.length === 1 ? "" : "s"}: ${names}. ` +
        `Instances reference them by name — add their source files to your toolchain.`,
      );
    } else {
      vscode.window.showInformationMessage(`${pick.label} exported: ${path.basename(target.fsPath)}`);
    }
  }

  public dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    CircuitEditor.instances = CircuitEditor.instances.filter((e) => e !== this);
  }

  // ----- HTML --------------------------------------------------------------

  private renderHtml(): string {
    const gateNames = ["and", "or", "xor", "nand", "nor", "xnor", "not", "buf", "dff", "input", "output"] as const;
    const gateUris: Record<string, string> = {};
    for (const name of gateNames) {
      const uri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "media", "gates", `${name}.svg`)
      );
      gateUris[name.toUpperCase()] = uri.toString();
    }
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${this.panel.webview.cspSource} data:`,
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
  .node rect:not(.hit) { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border); stroke-width: 1.2; }
  .node.module rect { fill: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background)); }
  .node.has-color rect:not(.hit) { fill: var(--node-color); }
  .node.has-color .node-tint { fill: var(--node-color); fill-opacity: 0.35; stroke: var(--node-color); stroke-width: 1.5; }
  .node.selected rect:not(.hit) { stroke: var(--vscode-focusBorder); stroke-width: 2; }
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
  .waypoint { fill: var(--vscode-editor-background); stroke: var(--vscode-focusBorder); stroke-width: 1.5; cursor: move; }
  .waypoint:hover { fill: var(--vscode-focusBorder); }
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
    <button id="btnRouting" class="ghost" title="Toggle curved vs straight wires. Straight wires support routing waypoints.">Wires: curved</button>
    <label class="color-control" title="Color of the current selection (nodes or wire)"><input id="colorPicker" type="color" value="#6ab0f3" /></label>
    <button id="btnClearColor" class="ghost" title="Remove color override from selection">Clear color</button>
    <span class="spacer"></span>
    <label>Module: <input id="moduleName" type="text" value="circuit" size="20" /></label>
    <span class="status" id="status"></span>
  </div>
  <div class="body">
    <div class="palette" id="palette">
      <h3>I/O</h3>
      <div class="item" draggable="true" data-type="INPUT">INPUT</div>
      <div class="item" draggable="true" data-type="OUTPUT">OUTPUT</div>
      <h3>Gates</h3>
      <div class="item" draggable="true" data-type="AND">AND</div>
      <div class="item" draggable="true" data-type="OR">OR</div>
      <div class="item" draggable="true" data-type="XOR">XOR</div>
      <div class="item" draggable="true" data-type="NAND">NAND</div>
      <div class="item" draggable="true" data-type="NOR">NOR</div>
      <div class="item" draggable="true" data-type="XNOR">XNOR</div>
      <div class="item" draggable="true" data-type="NOT">NOT</div>
      <div class="item" draggable="true" data-type="BUF">BUF</div>
      <h3>Sequential</h3>
      <div class="item" draggable="true" data-type="DFF">DFF</div>
      <h3>Modules</h3>
      <div id="moduleList"></div>
      <button class="add" id="btnImportModule">+ Import Circuit Module…</button>
      <button class="add" id="btnImportHdl" title="Import a Verilog/SystemVerilog module as a component">+ Import HDL Module…</button>
      <button class="add" id="btnReloadModules" title="Re-read every imported module from its source file">⟳ Reload from disk</button>
    </div>
    <div class="canvas-wrap">
      <svg class="canvas" id="canvas" xmlns="http://www.w3.org/2000/svg">
        <g id="viewport"></g>
      </svg>
      <div class="hint">
        Drag from palette • Click pin → click pin to wire • Dbl-click rename (use <code>name[7:0]</code> for buses)<br/>
        Drag empty canvas = box-select • Middle/Space-drag = pan • Wheel = zoom • Ctrl+C/V copy/paste • Ctrl+Z/Y undo
      </div>
    </div>
  </div>
  <div class="footer">
    <span id="footer">Untitled</span>
    <span id="zoomLabel">100%</span>
  </div>
</div>

<script nonce="${nonce}">const GATE_URIS = ${JSON.stringify(gateUris)};
${WEBVIEW_SCRIPT}
</script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (used by host emit and webview script via re-export below)
// ---------------------------------------------------------------------------

function sanitize(s: string): string {
  return (s || "").replace(/[^A-Za-z0-9_]/g, "_") || "u";
}

/** Map a file extension to one of the supported HDL flavours. */
function detectHdlLanguage(absPath: string): HdlLanguage {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".vhd" || ext === ".vhdl") { return "vhdl"; }
  if (ext === ".sv" || ext === ".svh") { return "systemverilog"; }
  return "verilog";
}

/**
 * Read an HDL file and dispatch to the right parser. Returns the module
 * declarations, the detected language, and the raw file contents (which the
 * caller snapshots into the circuit document so export stays self-contained).
 */
function parseHdlFile(absPath: string, relPath: string): { decls: ModuleDecl[]; language: HdlLanguage; source: string } {
  const source = fs.readFileSync(absPath, "utf8");
  const language = detectHdlLanguage(absPath);
  const decls = language === "vhdl"
    ? parseVhdlText(source, relPath)
    : parseVerilogText(source, relPath);
  return { decls, language, source };
}

/** Parse a port label like `data[7:0]` into { name, width }. */
function portFromLabel(label: string): ModulePort {
  const m = /^([A-Za-z_]\w*)\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*$/.exec((label || "").trim());
  if (m) {
    const hi = parseInt(m[2], 10), lo = parseInt(m[3], 10);
    return { label: m[1], width: Math.abs(hi - lo) + 1 };
  }
  const m2 = /^([A-Za-z_]\w*)\s*$/.exec((label || "").trim());
  return { label: m2 ? m2[1] : sanitize(label), width: 1 };
}

function widthDecl(width: number): string {
  return width > 1 ? `[${width - 1}:0] ` : "";
}

/** True if `doc` or any nested module body uses (sanitized) `targetName`. */
function referencesModule(doc: CircuitDoc, targetName: string): boolean {
  if (sanitize(doc.moduleName) === targetName) { return true; }
  for (const m of Object.values(doc.modules ?? {})) {
    if (m.body && referencesModule(m.body, targetName)) { return true; }
  }
  return false;
}

/**
 * Walk the module tree gathering every distinct module body keyed by
 * sanitized name. First-write-wins, so two trees with the same module
 * name keep the first body encountered — emit conflicts are surfaced
 * to the user separately by the caller if needed.
 *
 * HDL-imported modules (those with `hdlSource`) are collected into
 * `hdlSources` when they're language-compatible with the export target.
 * Mismatched-language imports go into `skipped` so the caller can warn —
 * the instance still gets emitted but the user must supply the source
 * file separately through the toolchain. Verilog and SystemVerilog are
 * treated as mutually compatible for inlining; VHDL is its own bucket.
 */
function collectModuleArtifacts(
  doc: CircuitDoc,
  bodies: Map<string, CircuitDoc>,
  hdlSources: Map<string, string>,
  skipped: Array<{ name: string; language: HdlLanguage }>,
  target: HdlLanguage,
): void {
  for (const [name, m] of Object.entries(doc.modules ?? {})) {
    const key = sanitize(name);
    if (m.hdlSource) {
      const lang: HdlLanguage = m.language ?? "verilog";
      const compatible = target === "vhdl" ? lang === "vhdl" : lang !== "vhdl";
      if (compatible) {
        if (!hdlSources.has(key) && !bodies.has(key)) { hdlSources.set(key, m.hdlSource); }
      } else if (!skipped.some((s) => s.name === name)) {
        skipped.push({ name, language: lang });
      }
      continue;
    }
    if (bodies.has(key) || !m.body) { continue; }
    bodies.set(key, m.body);
    collectModuleArtifacts(m.body, bodies, hdlSources, skipped, target);
  }
}

// ---------------------------------------------------------------------------
// HDL generation
// ---------------------------------------------------------------------------

export interface HdlGenerateResult {
  text: string;
  /** Modules whose snapshotted HDL source was not inlined because it's a
   *  different language than the export target. Instances still appear in
   *  the output; the user must add the source via their toolchain. */
  skipped: Array<{ name: string; language: HdlLanguage }>;
}

/**
 * Emit HDL for the top doc plus every transitively referenced module body
 * in the requested target language. Each synthesised module is emitted
 * once (deduped by sanitized name); the top module comes last so
 * dependents appear before their references.
 */
export function generateHdl(doc: CircuitDoc, target: HdlLanguage): HdlGenerateResult {
  const bodies = new Map<string, CircuitDoc>();
  const hdlSources = new Map<string, string>();
  const skipped: Array<{ name: string; language: HdlLanguage }> = [];
  collectModuleArtifacts(doc, bodies, hdlSources, skipped, target);

  const parts: string[] = [];
  for (const src of hdlSources.values()) { parts.push(src.trimEnd() + "\n"); }
  if (target === "vhdl") {
    for (const body of bodies.values()) { parts.push(emitVhdlEntity(body)); }
    parts.push(emitVhdlEntity(doc));
  } else {
    const useLogic = target === "systemverilog";
    for (const body of bodies.values()) { parts.push(emitVerilogModule(body, useLogic)); }
    parts.push(emitVerilogModule(doc, useLogic));
  }
  return { text: parts.join("\n"), skipped };
}

/** Backwards-compatible Verilog-only entry point. */
export function generateVerilog(doc: CircuitDoc): string {
  return generateHdl(doc, "verilog").text;
}

/**
 * Emit a single module in Verilog or SystemVerilog. SV swaps `wire`/`reg`
 * for `logic` throughout — the synthesis semantics are otherwise identical
 * for what this editor generates.
 */
function emitVerilogModule(doc: CircuitDoc, useLogic: boolean): string {
  const netKw = useLogic ? "logic" : "wire";
  const regKw = useLogic ? "logic" : "reg ";
  const portKw = useLogic ? "logic" : "wire";
  const moduleName = sanitize(doc.moduleName || "circuit");
  const modules = doc.modules ?? {};

  const inputs = doc.nodes.filter((n) => n.type === "INPUT");
  const outputs = doc.nodes.filter((n) => n.type === "OUTPUT");
  const internals = doc.nodes.filter((n) => n.type !== "INPUT" && n.type !== "OUTPUT");

  // For each (sinkId, pinIdx) record the driving net name.
  const driverOf = new Map<string, string>();
  for (const w of doc.wires) {
    const src = doc.nodes.find((n) => n.id === w.from.id);
    if (!src) { continue; }
    let net: string;
    if (src.type === "INPUT") {
      net = portFromLabel(src.label).label;
    } else if (src.type === "MODULE" && src.moduleRef && modules[src.moduleRef]) {
      // Each module instance gets one wire per output pin.
      net = `n_${sanitize(src.id)}_o${w.from.pin}`;
    } else {
      net = `n_${sanitize(src.id)}`;
    }
    driverOf.set(`${w.to.id}:${w.to.pin}`, net);
  }
  const sinkOf = (nodeId: string, pin: number, width = 1): string =>
    driverOf.get(`${nodeId}:${pin}`) ?? (width > 1 ? `${width}'d0` : `1'b0`);

  // Port list.
  const inPorts = inputs.map((n) => portFromLabel(n.label));
  const outPorts = outputs.map((n) => portFromLabel(n.label));
  const portList = [...inPorts, ...outPorts].map((p) => p.label);

  const out: string[] = [];
  out.push(`// Auto-generated by Bitstream Circuit Editor.`);
  out.push(`module ${moduleName} (${portList.join(", ")});`);
  for (const p of inPorts) { out.push(`    input  ${portKw} ${widthDecl(p.width)}${p.label};`); }
  for (const p of outPorts) { out.push(`    output ${portKw} ${widthDecl(p.width)}${p.label};`); }
  out.push(``);

  // Declare internal nets. DFFs become regs (or logic in SV); module
  // instances expose one wire per output pin with the module's declared width.
  for (const n of internals) {
    if (n.type === "DFF") {
      out.push(`    ${regKw} n_${sanitize(n.id)};`);
    } else if (n.type === "MODULE") {
      const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
      if (!iface) { continue; }
      iface.outs.forEach((p, i) => {
        out.push(`    ${netKw} ${widthDecl(p.width)}n_${sanitize(n.id)}_o${i};`);
      });
    } else {
      out.push(`    ${netKw} n_${sanitize(n.id)};`);
    }
  }
  out.push(``);

  // Combinational + sequential + module instances.
  const binop = (op: string, n: CircuitNode, invert = false) => {
    const expr = `${sinkOf(n.id, 0)} ${op} ${sinkOf(n.id, 1)}`;
    out.push(`    assign n_${sanitize(n.id)} = ${invert ? `~(${expr})` : expr};`);
  };
  for (const n of internals) {
    switch (n.type) {
      case "AND": binop("&", n); break;
      case "OR": binop("|", n); break;
      case "XOR": binop("^", n); break;
      case "NAND": binop("&", n, true); break;
      case "NOR": binop("|", n, true); break;
      case "XNOR": binop("^", n, true); break;
      case "NOT": out.push(`    assign n_${sanitize(n.id)} = ~${sinkOf(n.id, 0)};`); break;
      case "BUF": out.push(`    assign n_${sanitize(n.id)} =  ${sinkOf(n.id, 0)};`); break;
      case "DFF":  /* below */ break;
      case "MODULE": {
        const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
        if (!iface || !n.moduleRef) { break; }
        const inst = `inst_${sanitize(n.id)}`;
        const connections: string[] = [];
        iface.ins.forEach((p, i) => {
          connections.push(`.${p.label}(${sinkOf(n.id, i, p.width)})`);
        });
        iface.outs.forEach((p, i) => {
          connections.push(`.${p.label}(n_${sanitize(n.id)}_o${i})`);
        });
        out.push(``);
        out.push(`    ${sanitize(n.moduleRef)} ${inst} (`);
        out.push(connections.map((c) => `        ${c}`).join(",\n"));
        out.push(`    );`);
        break;
      }
    }
  }

  const dffs = internals.filter((n) => n.type === "DFF");
  if (dffs.length) {
    out.push(``);
    for (const n of dffs) {
      const d = sinkOf(n.id, 0), clk = sinkOf(n.id, 1);
      out.push(`    always @(posedge ${clk}) n_${sanitize(n.id)} <= ${d};`);
    }
  }

  if (outputs.length) {
    out.push(``);
    for (const o of outputs) {
      const p = portFromLabel(o.label);
      out.push(`    assign ${p.label} = ${sinkOf(o.id, 0, p.width)};`);
    }
  }
  out.push(`endmodule`);
  out.push(``);
  return out.join("\n");
}

/**
 * Emit a single circuit as a VHDL entity + rtl architecture. Multi-bit ports
 * become `std_logic_vector`; 1-bit ports stay `std_logic`. Internal gate
 * nets are always 1-bit `std_logic`. Module instances use VHDL '93 direct
 * entity instantiation (`entity work.<name>`) so no separate component
 * declarations are needed.
 */
function emitVhdlEntity(doc: CircuitDoc): string {
  const moduleName = sanitize(doc.moduleName || "circuit");
  const modules = doc.modules ?? {};

  const inputs = doc.nodes.filter((n) => n.type === "INPUT");
  const outputs = doc.nodes.filter((n) => n.type === "OUTPUT");
  const internals = doc.nodes.filter((n) => n.type !== "INPUT" && n.type !== "OUTPUT");

  const driverOf = new Map<string, string>();
  for (const w of doc.wires) {
    const src = doc.nodes.find((n) => n.id === w.from.id);
    if (!src) { continue; }
    let net: string;
    if (src.type === "INPUT") {
      net = portFromLabel(src.label).label;
    } else if (src.type === "MODULE" && src.moduleRef && modules[src.moduleRef]) {
      net = `n_${sanitize(src.id)}_o${w.from.pin}`;
    } else {
      net = `n_${sanitize(src.id)}`;
    }
    driverOf.set(`${w.to.id}:${w.to.pin}`, net);
  }
  const sinkOf = (nodeId: string, pin: number, width = 1): string =>
    driverOf.get(`${nodeId}:${pin}`) ?? (width > 1 ? `(others => '0')` : `'0'`);

  const vhdlType = (w: number): string =>
    w > 1 ? `std_logic_vector(${w - 1} downto 0)` : `std_logic`;

  const inPorts = inputs.map((n) => portFromLabel(n.label));
  const outPorts = outputs.map((n) => portFromLabel(n.label));

  const out: string[] = [];
  out.push(`-- Auto-generated by Bitstream Circuit Editor.`);
  out.push(`library ieee;`);
  out.push(`use ieee.std_logic_1164.all;`);
  out.push(``);
  out.push(`entity ${moduleName} is`);
  if (inPorts.length || outPorts.length) {
    const portLines: string[] = [];
    for (const p of inPorts) { portLines.push(`        ${p.label} : in  ${vhdlType(p.width)}`); }
    for (const p of outPorts) { portLines.push(`        ${p.label} : out ${vhdlType(p.width)}`); }
    out.push(`    port (`);
    out.push(portLines.join(";\n"));
    out.push(`    );`);
  }
  out.push(`end entity ${moduleName};`);
  out.push(``);
  out.push(`architecture rtl of ${moduleName} is`);

  for (const n of internals) {
    if (n.type === "MODULE") {
      const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
      if (!iface) { continue; }
      iface.outs.forEach((p, i) => {
        out.push(`    signal n_${sanitize(n.id)}_o${i} : ${vhdlType(p.width)};`);
      });
    } else {
      // Gates and DFFs alike: 1-bit std_logic net carrying the gate result.
      out.push(`    signal n_${sanitize(n.id)} : std_logic;`);
    }
  }
  out.push(`begin`);

  const binop = (op: string, n: CircuitNode) => {
    out.push(`    n_${sanitize(n.id)} <= ${sinkOf(n.id, 0)} ${op} ${sinkOf(n.id, 1)};`);
  };
  for (const n of internals) {
    switch (n.type) {
      case "AND": binop("and", n); break;
      case "OR": binop("or", n); break;
      case "XOR": binop("xor", n); break;
      case "NAND": binop("nand", n); break;
      case "NOR": binop("nor", n); break;
      case "XNOR": binop("xnor", n); break;
      case "NOT": out.push(`    n_${sanitize(n.id)} <= not ${sinkOf(n.id, 0)};`); break;
      case "BUF": out.push(`    n_${sanitize(n.id)} <=     ${sinkOf(n.id, 0)};`); break;
      case "DFF": {
        const d = sinkOf(n.id, 0), clk = sinkOf(n.id, 1);
        out.push(``);
        out.push(`    process(${clk})`);
        out.push(`    begin`);
        out.push(`        if rising_edge(${clk}) then`);
        out.push(`            n_${sanitize(n.id)} <= ${d};`);
        out.push(`        end if;`);
        out.push(`    end process;`);
        break;
      }
      case "MODULE": {
        const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
        if (!iface || !n.moduleRef) { break; }
        const inst = `inst_${sanitize(n.id)}`;
        const conns: string[] = [];
        iface.ins.forEach((p, i) => {
          conns.push(`            ${p.label} => ${sinkOf(n.id, i, p.width)}`);
        });
        iface.outs.forEach((p, i) => {
          conns.push(`            ${p.label} => n_${sanitize(n.id)}_o${i}`);
        });
        out.push(``);
        out.push(`    ${inst} : entity work.${sanitize(n.moduleRef)}`);
        out.push(`        port map (`);
        out.push(conns.join(",\n"));
        out.push(`        );`);
        break;
      }
    }
  }

  if (outputs.length) {
    out.push(``);
    for (const o of outputs) {
      const p = portFromLabel(o.label);
      out.push(`    ${p.label} <= ${sinkOf(o.id, 0, p.width)};`);
    }
  }
  out.push(`end architecture rtl;`);
  out.push(``);
  return out.join("\n");
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

// ---------------------------------------------------------------------------
// Webview script
// ---------------------------------------------------------------------------
//
// Lives as a string literal so the whole editor ships in one file. Speaks the
// postMessage protocol documented at the top. Read top-to-bottom: model →
// render → interactions → toolbar/host plumbing.

const WEBVIEW_SCRIPT = `
const vscode = acquireVsCodeApi();

// ----- Component descriptors -----------------------------------------------
// Pin y-coords are computed from the SVG stub positions (viewBox 0 0 100 80)
// scaled to each node's h: y_node = y_svg * h / 80.
const FIXED_SHAPES = {
  INPUT:  { w: 60, h: 32, ins: [],                                              outs: [{ y: 16 }] },
  OUTPUT: { w: 60, h: 32, ins: [{ y: 16 }],                                     outs: [] },
  AND:    { w: 70, h: 50, ins: [{ y: 16 }, { y: 34 }],                          outs: [{ y: 25 }] },
  OR:     { w: 70, h: 50, ins: [{ y: 16 }, { y: 34 }],                          outs: [{ y: 25 }] },
  XOR:    { w: 70, h: 50, ins: [{ y: 16 }, { y: 34 }],                          outs: [{ y: 25 }] },
  NAND:   { w: 70, h: 50, ins: [{ y: 16 }, { y: 34 }],                          outs: [{ y: 25 }] },
  NOR:    { w: 70, h: 50, ins: [{ y: 16 }, { y: 34 }],                          outs: [{ y: 25 }] },
  XNOR:   { w: 70, h: 50, ins: [{ y: 16 }, { y: 34 }],                          outs: [{ y: 25 }] },
  NOT:    { w: 60, h: 40, ins: [{ y: 20 }],                                     outs: [{ y: 20 }] },
  BUF:    { w: 60, h: 40, ins: [{ y: 20 }],                                     outs: [{ y: 20 }] },
  DFF:    { w: 80, h: 60, ins: [{ y: 17, lbl: 'D' }, { y: 47, lbl: 'CLK' }],   outs: [{ y: 30, lbl: 'Q' }] },
};

/**
 * Per-node geometry. Fixed types come from FIXED_SHAPES; MODULE instances
 * size themselves from the imported interface so any port count fits.
 */
function shapeOf(node) {
  if (node.type !== 'MODULE') return FIXED_SHAPES[node.type];
  const iface = (doc.modules || {})[node.moduleRef] || { ins: [], outs: [] };
  const rows = Math.max(1, iface.ins.length, iface.outs.length);
  const h = 24 + rows * 22;
  const ins  = iface.ins.map((p, i)  => ({ y: 24 + i * 22, lbl: p.label, width: p.width }));
  const outs = iface.outs.map((p, i) => ({ y: 24 + i * 22, lbl: p.label, width: p.width }));
  return { w: 120, h, ins, outs };
}

/** Width of a node's pin, used to render bus markers and pick wire styling. */
function pinWidth(node, side, idx) {
  const s = shapeOf(node);
  const p = (side === 'in' ? s.ins[idx] : s.outs[idx]);
  if (p && p.width) return p.width;
  if (node.type === 'INPUT' || node.type === 'OUTPUT') return parseLabel(node.label).width;
  return 1;
}

function parseLabel(label) {
  const m = /^([A-Za-z_]\\w*)\\s*\\[\\s*(\\d+)\\s*:\\s*(\\d+)\\s*\\]\\s*$/.exec((label || '').trim());
  if (m) {
    const hi = parseInt(m[2], 10), lo = parseInt(m[3], 10);
    return { name: m[1], width: Math.abs(hi - lo) + 1 };
  }
  return { name: (label || '').trim(), width: 1 };
}

// ----- State ----------------------------------------------------------------
let doc = { moduleName: 'circuit', nodes: [], wires: [], modules: {}, routingStyle: 'curved' };
let nextId = 1;
let selectedNodes = new Set();
let selectedWire = null;
let pendingWire = null;          // { from, mouse }
let dragging = null;             // { dx: Map<id, {dx,dy}>, moved: boolean }
let draggingWaypoint = null;     // { wire, idx, dx, dy, moved, pre }
let panning = null;              // { startX, startY, startTx, startTy }
let spaceHeld = false;
let rubber = null;               // { x0, y0, x1, y1 }
let view = { tx: 0, ty: 0, scale: 1 };
let history = [];                // past snapshots (JSON strings)
let future = [];                 // redo stack
let clipboard = null;            // { nodes, wires }
let dirty = false;
const HISTORY_LIMIT = 100;

const svg = document.getElementById('canvas');
const viewport = document.getElementById('viewport');
const status = document.getElementById('status');
const footer = document.getElementById('footer');
const zoomLabel = document.getElementById('zoomLabel');
const moduleNameInput = document.getElementById('moduleName');
const moduleListEl = document.getElementById('moduleList');
const btnRouting = document.getElementById('btnRouting');
const colorPicker = document.getElementById('colorPicker');
const btnClearColor = document.getElementById('btnClearColor');
const DEFAULT_PICKER_COLOR = '#6ab0f3';

function freshId() { return 'n' + (nextId++); }
function setDirty(v) { if (dirty === v) return; dirty = v; vscode.postMessage({ type: 'dirty', payload: v }); }
function routingStyle() { return doc.routingStyle || 'curved'; }
function updateRoutingButton() {
  btnRouting.textContent = 'Wires: ' + routingStyle();
}
function isHexColor(v) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v || '');
}
function selectionColor() {
  if (selectedWire) return selectedWire.color || null;
  if (!selectedNodes.size) return null;
  let color = null;
  for (const id of selectedNodes) {
    const node = doc.nodes.find((n) => n.id === id);
    if (!node || !node.color) return null;
    if (color == null) color = node.color;
    else if (color !== node.color) return null;
  }
  return color;
}
function syncColorPickerToSelection() {
  const hasSelection = !!selectedWire || selectedNodes.size > 0;
  const color = selectionColor();
  colorPicker.disabled = !hasSelection;
  btnClearColor.disabled = !hasSelection || !color;
  const next = color && isHexColor(color) ? color : DEFAULT_PICKER_COLOR;
  if (colorPicker.value !== next) colorPicker.value = next;
}

function applySelectionColor(color) {
  if (selectedWire) {
    if (selectedWire.color === color) return;
    pushHistory();
    selectedWire.color = color;
    setDirty(true);
    render();
    return;
  }
  if (!selectedNodes.size) return;
  let changed = false;
  for (const id of selectedNodes) {
    const node = doc.nodes.find((n) => n.id === id);
    if (node && node.color !== color) { changed = true; break; }
  }
  if (!changed) return;
  pushHistory();
  for (const id of selectedNodes) {
    const node = doc.nodes.find((n) => n.id === id);
    if (node) node.color = color;
  }
  setDirty(true);
  render();
}

function clearSelectionColor() {
  if (selectedWire) {
    if (!selectedWire.color) return;
    pushHistory();
    delete selectedWire.color;
    setDirty(true);
    render();
    return;
  }
  if (!selectedNodes.size) return;
  let changed = false;
  for (const id of selectedNodes) {
    const node = doc.nodes.find((n) => n.id === id);
    if (node && node.color) { changed = true; break; }
  }
  if (!changed) return;
  pushHistory();
  for (const id of selectedNodes) {
    const node = doc.nodes.find((n) => n.id === id);
    if (node && node.color) delete node.color;
  }
  setDirty(true);
  render();
}

function defaultLabel(type, moduleRef) {
  if (type === 'MODULE') {
    const same = doc.nodes.filter((n) => n.type === 'MODULE' && n.moduleRef === moduleRef).length;
    return moduleRef + (same + 1);
  }
  const same = doc.nodes.filter((n) => n.type === type).length;
  if (type === 'INPUT')  return 'in' + (same + 1);
  if (type === 'OUTPUT') return 'out' + (same + 1);
  return type.toLowerCase() + (same + 1);
}

// ----- History --------------------------------------------------------------
// Snapshots are full JSON copies of doc; small enough that we don't bother
// with diff-based history for a prototype. Selection is intentionally not
// snapshotted — after undo the user sees an empty selection, which keeps
// behaviour predictable when they immediately edit again.
function snapshot() { return JSON.stringify(doc); }
function pushHistory() {
  history.push(snapshot());
  if (history.length > HISTORY_LIMIT) history.shift();
  future.length = 0;
}
function undo() {
  if (!history.length) return;
  future.push(snapshot());
  doc = JSON.parse(history.pop());
  resyncAfterReplace();
}
function redo() {
  if (!future.length) return;
  history.push(snapshot());
  doc = JSON.parse(future.pop());
  resyncAfterReplace();
}
function resyncAfterReplace() {
  let maxN = 0;
  for (const n of doc.nodes) { const m = /^n(\\d+)$/.exec(n.id); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  nextId = maxN + 1;
  moduleNameInput.value = doc.moduleName || 'circuit';
  rebuildModulePalette();
  selectedNodes.clear(); selectedWire = null; pendingWire = null;
  updateRoutingButton();
  syncColorPickerToSelection();
  setDirty(true);
  render();
}

// ----- Coordinate transforms ------------------------------------------------
function clientToContent(e) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - view.tx) / view.scale,
    y: (e.clientY - rect.top  - view.ty) / view.scale,
  };
}
function applyView() {
  viewport.setAttribute('transform', 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')');
  zoomLabel.textContent = Math.round(view.scale * 100) + '%';
}

// ----- Render ---------------------------------------------------------------
function pinPos(node, side, idx) {
  const s = shapeOf(node);
  const p = (side === 'in' ? s.ins[idx] : s.outs[idx]);
  if (!p) return { x: node.x, y: node.y };
  return { x: node.x + (side === 'in' ? 0 : s.w), y: node.y + p.y };
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// We batch render calls onto requestAnimationFrame. Multiple mousemove or
// keydown bursts inside a single frame collapse to one DOM update — the
// dominant cost at scale. The actual draw happens in _render(); call sites
// keep calling render() as before.
let _renderPending = false;
function render() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => { _renderPending = false; _render(); });
}

function visibleRect() {
  // Inverse of the viewport transform: which content-space rect is visible?
  const rect = svg.getBoundingClientRect();
  return {
    x: (-view.tx) / view.scale,
    y: (-view.ty) / view.scale,
    w: rect.width / view.scale,
    h: rect.height / view.scale,
  };
}

function rectIntersects(ax, ay, aw, ah, bx, by, bw, bh) {
  return !(ax + aw < bx || bx + bw < ax || ay + ah < by || by + bh < ay);
}

function _render() {
  viewport.innerHTML = '';

  // Level-of-detail tier — when zoomed out, drop pin labels and type stripes
  // (medium) or skip everything except node outlines (low). Pinned values
  // around the common-case 1.0 zoom so detail is full.
  const lod = view.scale < 0.25 ? 'low' : (view.scale < 0.5 ? 'medium' : 'high');
  // Cull nodes outside the visible content rect (with a margin for partial
  // overlaps). At 1.0 zoom on a typical screen, this is a no-op; zoomed in
  // it skips most of the design.
  const vis = visibleRect();
  const MARGIN = 120;
  const vx = vis.x - MARGIN, vy = vis.y - MARGIN, vw = vis.w + 2 * MARGIN, vh = vis.h + 2 * MARGIN;

  // Precompute culling decisions once per node — used by wire skipping below.
  const culled = new Set();
  for (const n of doc.nodes) {
    const s = shapeOf(n);
    if (!rectIntersects(n.x, n.y, s.w, s.h, vx, vy, vw, vh)) { culled.add(n.id); }
  }

  // Wires first so node bodies overlay endpoints. A wire is drawn unless
  // *both* endpoints are culled — otherwise it'd disappear when one end is
  // pulled off-screen during a drag.
  const straightMode = routingStyle() === 'straight';
  for (const w of doc.wires) {
    if (culled.has(w.from.id) && culled.has(w.to.id)) continue;
    const src = doc.nodes.find((n) => n.id === w.from.id);
    const dst = doc.nodes.find((n) => n.id === w.to.id);
    if (!src || !dst) continue;
    const a = pinPos(src, w.from.side, w.from.pin);
    const b = pinPos(dst, w.to.side,   w.to.pin);
    const width = Math.max(pinWidth(src, 'out', w.from.pin), pinWidth(dst, 'in', w.to.pin));
    const isSelected = selectedWire === w;
    const hasColor = !!w.color;
    const klass = 'wire'
      + (width > 1 ? ' bus' : '')
      + (isSelected ? ' selected' : '')
      + (hasColor ? ' has-color' : '');
    const path = svgEl('path', { d: wirePath(a, b, w), class: klass });
    if (hasColor) path.style.setProperty('--wire-color', w.color);
    path.addEventListener('mousedown', (e) => { e.stopPropagation(); selectedWire = w; selectedNodes.clear(); syncColorPickerToSelection(); render(); });
    path.addEventListener('dblclick', (e) => {
      if (!straightMode) return;
      e.stopPropagation();
      insertWaypoint(w, clientToContent(e));
    });
    viewport.appendChild(path);
    if (width > 1 && lod === 'high') {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 4;
      const tag = svgEl('text', { class: 'wire-label', x: mx, y: my, 'text-anchor': 'middle' });
      tag.textContent = '[' + width + ']';
      viewport.appendChild(tag);
    }
    // Waypoint handles render only for the selected wire in straight mode —
    // keeps the canvas quiet when the user isn't routing.
    if (isSelected && straightMode) {
      (w.waypoints || []).forEach((wp, idx) => {
        const handle = svgEl('rect', { class: 'waypoint', x: wp.x - 5, y: wp.y - 5, width: 10, height: 10, rx: 2, ry: 2 });
        handle.addEventListener('mousedown', (e) => onWaypointDown(e, w, idx));
        viewport.appendChild(handle);
      });
    }
  }

  if (pendingWire) {
    const src = doc.nodes.find((n) => n.id === pendingWire.from.id);
    if (src) {
      const a = pinPos(src, pendingWire.from.side, pendingWire.from.pin);
      const b = pendingWire.mouse;
      viewport.appendChild(svgEl('path', { d: wirePath(a, b, null), class: 'wire pending' }));
    }
  }

  for (const n of doc.nodes) {
    if (culled.has(n.id)) continue;
    renderNode(n, lod);
  }

  if (rubber) {
    const x = Math.min(rubber.x0, rubber.x1), y = Math.min(rubber.y0, rubber.y1);
    const w = Math.abs(rubber.x1 - rubber.x0), h = Math.abs(rubber.y1 - rubber.y0);
    viewport.appendChild(svgEl('rect', { class: 'rubber', x, y, width: w, height: h }));
  }
}

function bezier(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + dx) + ' ' + a.y + ', ' + (b.x - dx) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
}

/**
 * Build the SVG path 'd' attribute for a wire. Curved mode uses a single
 * bezier; straight mode draws a polyline that passes through every waypoint
 * (or a default L-route between the endpoints if none).
 */
function wirePath(a, b, wire) {
  if (routingStyle() === 'curved') return bezier(a, b);
  const wps = (wire && wire.waypoints) || [];
  if (!wps.length) {
    // Default Manhattan-style Z route: out → mid-x at a.y → mid-x at b.y → in.
    const mx = (a.x + b.x) / 2;
    return 'M ' + a.x + ' ' + a.y + ' L ' + mx + ' ' + a.y + ' L ' + mx + ' ' + b.y + ' L ' + b.x + ' ' + b.y;
  }
  const parts = ['M ' + a.x + ' ' + a.y];
  for (const wp of wps) parts.push('L ' + wp.x + ' ' + wp.y);
  parts.push('L ' + b.x + ' ' + b.y);
  return parts.join(' ');
}

/** Distance from a point to the line segment a-b. */
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Insert a new routing waypoint at \`pt\` into wire \`w\`. The insertion index
 * is chosen so the click point lands on the polyline segment it's closest to,
 * which keeps the wire visually unchanged at the moment of insert.
 */
function insertWaypoint(w, pt) {
  const src = doc.nodes.find((n) => n.id === w.from.id);
  const dst = doc.nodes.find((n) => n.id === w.to.id);
  if (!src || !dst) return;
  const a = pinPos(src, w.from.side, w.from.pin);
  const b = pinPos(dst, w.to.side, w.to.pin);
  const wps = (w.waypoints || []).slice();
  const pts = [a, ...wps, b];
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(pt, pts[i], pts[i + 1]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  pushHistory();
  wps.splice(bestIdx, 0, { x: pt.x, y: pt.y });
  w.waypoints = wps;
  setDirty(true);
  render();
}

function onWaypointDown(e, wire, idx) {
  e.stopPropagation();
  const wps = (wire.waypoints || []).slice();
  if (!wps[idx]) return;
  if (e.shiftKey) {
    pushHistory();
    wps.splice(idx, 1);
    wire.waypoints = wps.length ? wps : undefined;
    setDirty(true);
    render();
    return;
  }
  const pt = clientToContent(e);
  draggingWaypoint = {
    wire,
    idx,
    dx: pt.x - wps[idx].x,
    dy: pt.y - wps[idx].y,
    moved: false,
    pre: snapshot(),
  };
}

function renderNode(n, lod) {
  const s = shapeOf(n);
  const isModule = n.type === 'MODULE';
  const gateUri = !isModule && GATE_URIS[n.type];
  const hasColor = !!n.color;
  const g = svgEl('g', {
    class: 'node' + (selectedNodes.has(n.id) ? ' selected' : '') + (isModule ? ' module' : '') + (hasColor ? ' has-color' : ''),
    transform: 'translate(' + n.x + ',' + n.y + ')',
  });
  if (hasColor) g.style.setProperty('--node-color', n.color);

  if (gateUri) {
    // SVG icon fills the node bounds; stubs in the SVG reach x=0 (left) and
    // x=100→s.w (right), so wire endpoints land exactly on the pin circles.
    g.appendChild(svgEl('image', { href: gateUri, x: 0, y: 0, width: s.w, height: s.h, preserveAspectRatio: 'none' }));
    g.appendChild(svgEl('rect', { class: 'node-tint', x: 0, y: 0, width: s.w, height: s.h, rx: 3, ry: 3 }));
    // Transparent rect provides the selection stroke and a reliable hit target.
    g.appendChild(svgEl('rect', { class: 'hit', x: 0, y: 0, width: s.w, height: s.h, rx: 3, ry: 3 }));
  } else {
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: s.w, height: s.h, rx: 4, ry: 4 }));
  }

  if (lod !== 'low') {
    // For gate icons the type is conveyed visually; show the instance label
    // below the symbol. For I/O and MODULE keep it inside the box.
    const isIO = n.type === 'INPUT' || n.type === 'OUTPUT';
    const labelY = gateUri && !isIO ? s.h + 12 : (isModule ? 14 : s.h / 2 + 4);
    const labelEl = svgEl('text', { class: 'label', x: s.w / 2, y: labelY });
    labelEl.textContent = n.label;
    g.appendChild(labelEl);
    if (isModule) {
      const typeEl = svgEl('text', { class: 'type', x: s.w / 2, y: s.h - 4 });
      typeEl.textContent = n.moduleRef;
      g.appendChild(typeEl);
    }
  }

  // Pins are always rendered so wiring remains possible at any zoom. Pin
  // labels are dropped under 'medium' to keep the visual quiet.
  s.ins.forEach((p, i) => {
    const w = pinWidth(n, 'in', i);
    g.appendChild(makePin(0, p.y, w, (e) => onPinDown(e, n, 'in', i)));
    if (p.lbl && lod === 'high') g.appendChild(pinLabel(10, p.y + 3, p.lbl, 'start'));
  });
  s.outs.forEach((p, i) => {
    const w = pinWidth(n, 'out', i);
    g.appendChild(makePin(s.w, p.y, w, (e) => onPinDown(e, n, 'out', i)));
    if (p.lbl && lod === 'high') g.appendChild(pinLabel(s.w - 10, p.y + 3, p.lbl, 'end'));
  });

  g.addEventListener('mousedown', (e) => onNodeDown(e, n));
  g.addEventListener('dblclick', () => {
    // MODULE nodes drill down to their source design; everything else opens
    // the label-rename prompt.
    if (isModule) {
      const iface = (doc.modules || {})[n.moduleRef];
      if (iface && iface.file) {
        vscode.postMessage({ type: 'openModule', file: iface.file });
      } else {
        status.textContent = 'Module has no file path; save this circuit and re-import.';
        setTimeout(() => { status.textContent = ''; }, 2500);
      }
      return;
    }
    renameNode(n);
  });
  viewport.appendChild(g);
}

function makePin(cx, cy, width, handler) {
  const el = svgEl('circle', { class: 'pin' + (width > 1 ? ' bus' : ''), cx, cy, r: width > 1 ? 5 : 4 });
  el.addEventListener('mousedown', handler);
  return el;
}
function pinLabel(x, y, text, anchor) {
  const t = svgEl('text', { class: 'pin-label', x, y, 'text-anchor': anchor });
  t.textContent = text;
  return t;
}

function renameNode(n) {
  const hint = (n.type === 'INPUT' || n.type === 'OUTPUT') ? '  (use name[7:0] for buses)' : '';
  const v = prompt('Label for ' + n.type + hint, n.label);
  if (v == null) return;
  const trimmed = v.trim();
  if (!trimmed || trimmed === n.label) return;
  pushHistory();
  n.label = trimmed;
  setDirty(true);
  render();
}

// ----- Interaction ----------------------------------------------------------
function onNodeDown(e, n) {
  if (e.target.classList.contains('pin')) return;
  // Shift toggles membership; plain click on an unselected node replaces.
  if (e.shiftKey) {
    if (selectedNodes.has(n.id)) selectedNodes.delete(n.id);
    else selectedNodes.add(n.id);
  } else if (!selectedNodes.has(n.id)) {
    selectedNodes.clear();
    selectedNodes.add(n.id);
  }
  selectedWire = null;
  syncColorPickerToSelection();

  // Drag all currently-selected nodes as a group. We capture per-node deltas
  // so members keep their relative positions during the drag.
  const pt = clientToContent(e);
  const offsets = new Map();
  for (const id of selectedNodes) {
    const node = doc.nodes.find((x) => x.id === id);
    if (node) offsets.set(id, { dx: pt.x - node.x, dy: pt.y - node.y });
  }
  dragging = { offsets, moved: false, pre: snapshot() };
  render();
}

function onPinDown(e, node, side, idx) {
  e.stopPropagation();
  if (!pendingWire) {
    pendingWire = { from: { id: node.id, pin: idx, side }, mouse: clientToContent(e) };
    render();
    return;
  }
  const a = pendingWire.from;
  const b = { id: node.id, pin: idx, side };
  pendingWire = null;
  if (a.side === b.side || a.id === b.id) { render(); return; }
  const src = a.side === 'out' ? a : b;
  const dst = a.side === 'in'  ? a : b;
  pushHistory();
  // Replace any existing driver on this sink — each input pin has one driver.
  doc.wires = doc.wires.filter((w) => !(w.to.id === dst.id && w.to.pin === dst.pin));
  doc.wires.push({ from: src, to: dst });
  setDirty(true);
  render();
}

svg.addEventListener('mousemove', (e) => {
  if (panning) {
    view.tx = panning.startTx + (e.clientX - panning.startX);
    view.ty = panning.startTy + (e.clientY - panning.startY);
    applyView();
    return;
  }
  if (draggingWaypoint) {
    const pt = clientToContent(e);
    const wps = draggingWaypoint.wire.waypoints || [];
    const wp = wps[draggingWaypoint.idx];
    if (wp) {
      wp.x = pt.x - draggingWaypoint.dx;
      wp.y = pt.y - draggingWaypoint.dy;
      draggingWaypoint.moved = true;
      render();
    }
    return;
  }
  if (dragging) {
    const pt = clientToContent(e);
    dragging.moved = true;
    for (const id of selectedNodes) {
      const node = doc.nodes.find((x) => x.id === id);
      const off = dragging.offsets.get(id);
      if (node && off) { node.x = pt.x - off.dx; node.y = pt.y - off.dy; }
    }
    render();
  } else if (rubber) {
    const pt = clientToContent(e);
    rubber.x1 = pt.x; rubber.y1 = pt.y;
    render();
  } else if (pendingWire) {
    pendingWire.mouse = clientToContent(e);
    render();
  }
});

window.addEventListener('mouseup', () => {
  if (dragging) {
    if (dragging.moved) {
      // We snapshotted pre-drag state but only commit it if the drag actually
      // changed positions — otherwise plain clicks would pollute history.
      history.push(dragging.pre);
      if (history.length > HISTORY_LIMIT) history.shift();
      future.length = 0;
      setDirty(true);
    }
    dragging = null;
  }
  if (draggingWaypoint) {
    if (draggingWaypoint.moved) {
      history.push(draggingWaypoint.pre);
      if (history.length > HISTORY_LIMIT) history.shift();
      future.length = 0;
      setDirty(true);
    }
    draggingWaypoint = null;
  }
  if (rubber) {
    finalizeRubber();
    rubber = null;
    render();
  }
  if (panning) { panning = null; svg.classList.remove('panning'); }
});

function finalizeRubber() {
  const x = Math.min(rubber.x0, rubber.x1), y = Math.min(rubber.y0, rubber.y1);
  const x2 = Math.max(rubber.x0, rubber.x1), y2 = Math.max(rubber.y0, rubber.y1);
  for (const n of doc.nodes) {
    const s = shapeOf(n);
    const hit = !(n.x + s.w < x || n.x > x2 || n.y + s.h < y || n.y > y2);
    if (hit) selectedNodes.add(n.id);
  }
  syncColorPickerToSelection();
}

svg.addEventListener('mousedown', (e) => {
  if (e.target !== svg && e.target.id !== 'viewport') return;
  // Pan with middle-mouse or space-held left-mouse; otherwise start rubber-band.
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    panning = { startX: e.clientX, startY: e.clientY, startTx: view.tx, startTy: view.ty };
    svg.classList.add('panning');
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  pendingWire = null;
  if (!e.shiftKey) { selectedNodes.clear(); selectedWire = null; }
  syncColorPickerToSelection();
  const pt = clientToContent(e);
  rubber = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
  render();
});

// Wheel zoom, anchored on the cursor so the point under the mouse stays put.
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const factor = Math.exp(-e.deltaY * 0.0015);
  const next = Math.max(0.2, Math.min(4, view.scale * factor));
  // Solve: (mx - tx) / scale == (mx - tx') / next  →  tx' = mx - (mx - tx) * (next/scale)
  view.tx = mx - (mx - view.tx) * (next / view.scale);
  view.ty = my - (my - view.ty) * (next / view.scale);
  view.scale = next;
  applyView();
}, { passive: false });

// ----- Keyboard -------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const meta = e.ctrlKey || e.metaKey;

  if (e.code === 'Space') { spaceHeld = true; svg.classList.add('spacing'); e.preventDefault(); return; }
  if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (meta && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
  if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
  if (meta && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectedNodes = new Set(doc.nodes.map((n) => n.id));
    selectedWire = null;
    syncColorPickerToSelection();
    render();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selectedNodes.size && !selectedWire) return;
    e.preventDefault();
    pushHistory();
    if (selectedNodes.size) {
      doc.nodes = doc.nodes.filter((n) => !selectedNodes.has(n.id));
      doc.wires = doc.wires.filter((w) => !selectedNodes.has(w.from.id) && !selectedNodes.has(w.to.id));
      selectedNodes.clear();
    }
    if (selectedWire) {
      doc.wires = doc.wires.filter((w) => w !== selectedWire);
      selectedWire = null;
    }
    syncColorPickerToSelection();
    setDirty(true);
    render();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceHeld = false; svg.classList.remove('spacing'); }
});

// ----- Clipboard ------------------------------------------------------------
// We clone selected nodes and the wires that are *fully* inside the selection.
// Wires that cross the selection boundary are dropped because their endpoints
// would have nothing to attach to in the pasted copy.
function copySelection() {
  if (!selectedNodes.size) { clipboard = null; return; }
  const nodes = doc.nodes.filter((n) => selectedNodes.has(n.id)).map((n) => JSON.parse(JSON.stringify(n)));
  const ids = new Set(nodes.map((n) => n.id));
  const wires = doc.wires.filter((w) => ids.has(w.from.id) && ids.has(w.to.id)).map((w) => JSON.parse(JSON.stringify(w)));
  clipboard = { nodes, wires };
  status.textContent = 'Copied ' + nodes.length + ' node' + (nodes.length === 1 ? '' : 's');
  setTimeout(() => { if (status.textContent.startsWith('Copied')) status.textContent = ''; }, 1500);
}
function pasteClipboard() {
  if (!clipboard || !clipboard.nodes.length) return;
  pushHistory();
  const OFFSET = 24;
  const idMap = new Map();
  const newNodes = clipboard.nodes.map((n) => {
    const fresh = freshId();
    idMap.set(n.id, fresh);
    return Object.assign({}, n, { id: fresh, x: n.x + OFFSET, y: n.y + OFFSET, label: n.label });
  });
  const newWires = clipboard.wires.map((w) => {
    const waypoints = (w.waypoints || []).map((wp) => ({ x: wp.x + OFFSET, y: wp.y + OFFSET }));
    const out = {
      from: { id: idMap.get(w.from.id), pin: w.from.pin, side: w.from.side },
      to:   { id: idMap.get(w.to.id),   pin: w.to.pin,   side: w.to.side },
    };
    if (w.color) out.color = w.color;
    if (waypoints.length) out.waypoints = waypoints;
    return out;
  });
  doc.nodes.push(...newNodes);
  doc.wires.push(...newWires);
  selectedNodes = new Set(newNodes.map((n) => n.id));
  selectedWire = null;
  syncColorPickerToSelection();
  setDirty(true);
  render();
}

// ----- Palette: built-in items and dynamic modules --------------------------
document.querySelectorAll('.palette .item').forEach((el) => attachPaletteDrag(el));
function attachPaletteDrag(el) {
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/bitstream-node', el.dataset.type);
    if (el.dataset.module) e.dataTransfer.setData('text/bitstream-module', el.dataset.module);
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function rebuildModulePalette() {
  moduleListEl.innerHTML = '';
  const modules = doc.modules || {};
  for (const name of Object.keys(modules).sort()) {
    const item = document.createElement('div');
    item.className = 'item';
    item.draggable = true;
    item.dataset.type = 'MODULE';
    item.dataset.module = name;
    const iface = modules[name];
    item.innerHTML = '<span>' + name + '</span><span class="badge">' + iface.ins.length + ' in / ' + iface.outs.length + ' out</span>';
    attachPaletteDrag(item);
    moduleListEl.appendChild(item);
  }
}

document.getElementById('btnImportModule').addEventListener('click', () => {
  // Host needs our own moduleName so it can refuse cycles up front.
  vscode.postMessage({ type: 'importModule', ownName: doc.moduleName });
});
document.getElementById('btnImportHdl').addEventListener('click', () => {
  vscode.postMessage({ type: 'importHdlModule', ownName: doc.moduleName });
});
document.getElementById('btnReloadModules').addEventListener('click', () => {
  const list = Object.entries(doc.modules || {})
    .filter(([, iface]) => !!iface.file)
    .map(([name, iface]) => ({ name, file: iface.file }));
  if (!list.length) { status.textContent = 'No modules to reload'; setTimeout(() => { status.textContent = ''; }, 1500); return; }
  vscode.postMessage({ type: 'reloadModules', modules: list });
});

svg.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
svg.addEventListener('drop', (e) => {
  e.preventDefault();
  const type = e.dataTransfer.getData('text/bitstream-node');
  if (!type) return;
  const moduleRef = e.dataTransfer.getData('text/bitstream-module') || undefined;
  if (type === 'MODULE' && (!moduleRef || !(doc.modules || {})[moduleRef])) return;
  if (type !== 'MODULE' && !FIXED_SHAPES[type]) return;
  pushHistory();
  const pt = clientToContent(e);
  const node = { id: freshId(), type, x: pt.x, y: pt.y, label: defaultLabel(type, moduleRef) };
  if (moduleRef) node.moduleRef = moduleRef;
  const s = shapeOf(node);
  node.x -= s.w / 2; node.y -= s.h / 2;
  doc.nodes.push(node);
  selectedNodes = new Set([node.id]);
  selectedWire = null;
  syncColorPickerToSelection();
  setDirty(true);
  render();
});

// ----- Toolbar --------------------------------------------------------------
moduleNameInput.addEventListener('input', () => { doc.moduleName = moduleNameInput.value || 'circuit'; setDirty(true); });
document.getElementById('btnNew').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  doc = { moduleName: 'circuit', nodes: [], wires: [], modules: {}, routingStyle: 'curved' };
  nextId = 1; selectedNodes.clear(); selectedWire = null; pendingWire = null;
  history.length = 0; future.length = 0;
  view = { tx: 0, ty: 0, scale: 1 }; applyView();
  moduleNameInput.value = doc.moduleName;
  footer.textContent = 'Untitled';
  rebuildModulePalette();
  setDirty(false);
  updateRoutingButton();
  syncColorPickerToSelection();
  render();
});
document.getElementById('btnOpen').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
document.getElementById('btnSave').addEventListener('click', () => vscode.postMessage({ type: 'save', payload: doc }));
document.getElementById('btnSaveAs').addEventListener('click', () => vscode.postMessage({ type: 'save', payload: doc, asNew: true }));
document.getElementById('btnExport').addEventListener('click', () => vscode.postMessage({ type: 'exportHdl', payload: doc }));
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);
btnRouting.addEventListener('click', () => {
  pushHistory();
  doc.routingStyle = routingStyle() === 'curved' ? 'straight' : 'curved';
  setDirty(true);
  updateRoutingButton();
  render();
});
colorPicker.addEventListener('input', () => {
  if (!selectedWire && !selectedNodes.size) return;
  applySelectionColor(colorPicker.value);
  syncColorPickerToSelection();
});
btnClearColor.addEventListener('click', () => {
  if (!selectedWire && !selectedNodes.size) return;
  clearSelectionColor();
  syncColorPickerToSelection();
});

// ----- Host messages --------------------------------------------------------
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'loaded') {
    doc = msg.payload || { moduleName: 'circuit', nodes: [], wires: [], modules: {} };
    if (!doc.modules) doc.modules = {};
    if (!doc.routingStyle) doc.routingStyle = 'curved';
    let maxN = 0;
    for (const n of doc.nodes) { const m = /^n(\\d+)$/.exec(n.id); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
    nextId = maxN + 1;
    moduleNameInput.value = doc.moduleName || 'circuit';
    footer.textContent = msg.path || 'Untitled';
    selectedNodes.clear(); selectedWire = null; pendingWire = null;
    history.length = 0; future.length = 0;
    view = { tx: 0, ty: 0, scale: 1 }; applyView();
    rebuildModulePalette();
    setDirty(false);
    updateRoutingButton();
    syncColorPickerToSelection();
    render();
  } else if (msg.type === 'saved') {
    footer.textContent = msg.path; setDirty(false); status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 1500);
  } else if (msg.type === 'moduleImported') {
    pushHistory();
    if (!doc.modules) doc.modules = {};
    doc.modules[msg.name] = msg.iface;
    setDirty(true);
    rebuildModulePalette();
    status.textContent = 'Imported module: ' + msg.name;
    setTimeout(() => { if (status.textContent.startsWith('Imported')) status.textContent = ''; }, 2000);
  } else if (msg.type === 'modulesReloaded') {
    pushHistory();
    if (!doc.modules) doc.modules = {};
    for (const { name, iface } of (msg.refreshed || [])) { doc.modules[name] = iface; }
    setDirty(true);
    rebuildModulePalette();
    render();
    const refreshed = (msg.refreshed || []).length;
    const missing = msg.missing || [];
    if (missing.length) {
      status.textContent = 'Reloaded ' + refreshed + ', missing: ' + missing.join(', ');
    } else {
      status.textContent = 'Reloaded ' + refreshed + ' module' + (refreshed === 1 ? '' : 's');
      setTimeout(() => { if (status.textContent.startsWith('Reloaded')) status.textContent = ''; }, 2000);
    }
  } else if (msg.type === 'info') {
    status.textContent = msg.message; setTimeout(() => { status.textContent = ''; }, 2000);
  } else if (msg.type === 'error') {
    status.textContent = msg.message;
  }
});

applyView();
updateRoutingButton();
syncColorPickerToSelection();
render();
`;
