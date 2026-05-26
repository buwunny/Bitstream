/**
 * circuit.ts
 * ----------------------------------------------------------------------------
 * Webview panel that hosts the graphical circuit editor. This file owns the
 * VS Code-facing side:
 *   • file IO for `.bscircuit.json` documents
 *   • module-interface import (circuit sub-designs and raw HDL leaf modules)
 *   • HDL export (Verilog / SystemVerilog / VHDL)
 *
 * The document model and helpers live in sibling files:
 *   • circuit-types.ts    — shared interfaces (CircuitDoc, ModuleInterface, …)
 *   • circuit-modules.ts  — module/HDL parsing helpers used by import + emit
 *   • circuit-hdl.ts      — HDL emit (Verilog / SystemVerilog / VHDL)
 *   • circuit-webview.ts  — the embedded webview HTML + script
 *
 * Webview ↔ host protocol:
 *     ws -> { type: "save",          payload: CircuitDoc, asNew?: boolean }
 *     ws -> { type: "open" }
 *     ws -> { type: "exportHdl",     payload: CircuitDoc }
 *     ws -> { type: "importModule" }
 *     ws -> { type: "importHdlModule" }
 *     ws -> { type: "openModule",    file: string }
 *     ws -> { type: "reloadModules", modules: Array<{ name, file }> }
 *     ws -> { type: "dirty",         payload: boolean }
 *     ho -> { type: "loaded",        payload: CircuitDoc, path: string }
 *     ho -> { type: "saved",         path: string }
 *     ho -> { type: "moduleImported", name, iface }
 *     ho -> { type: "modulesReloaded", refreshed, missing }
 *     ho -> { type: "info" | "error", message: string }
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  CircuitDoc,
  FILE_EXT,
  HdlLanguage,
  ModuleInterface,
  ModulePort,
} from "./circuit-types";
import { parseHdlFile, portFromLabel, referencesModule, sanitize } from "./circuit-modules";
import { generateHdl } from "./circuit-hdl";
import { renderCircuitHtml } from "./circuit-webview";

// Re-export the types and the HDL entry points so existing importers keep
// working. New code is encouraged to import directly from the sibling files.
export {
  CircuitDoc,
  CircuitNode,
  CircuitWire,
  HdlLanguage,
  ModuleInterface,
  ModulePort,
  NodeType,
  RoutingStyle,
} from "./circuit-types";
export { generateHdl, generateVerilog, HdlGenerateResult } from "./circuit-hdl";

// ---------------------------------------------------------------------------
// Editor panel
// ---------------------------------------------------------------------------

export class CircuitEditor {
  public static readonly viewType = "bitstream.circuit";
  private static instances: CircuitEditor[] = [];

  public static show(extensionUri: vscode.Uri, openFile?: vscode.Uri): void {
    const panel = CircuitEditor.createPanel(extensionUri);
    const editor = new CircuitEditor(panel, extensionUri);
    CircuitEditor.instances.push(editor);
    if (openFile) { editor.loadFromDisk(openFile); }
  }

  private static createPanel(extensionUri: vscode.Uri): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      CircuitEditor.viewType,
      "Circuit Editor",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
  }

  private readonly panel: vscode.WebviewPanel;
  private currentPath: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly extensionUri: vscode.Uri;

  // Latest doc snapshot pushed from the webview. Used by the close prompt:
  // webview panels can't block their own disposal, so when onDidDispose fires
  // while dirty we read this cache to either save the file or reopen the
  // panel with state preserved.
  private cachedDoc: CircuitDoc | undefined;
  private isDirty = false;
  // Set when we're tearing down for real (after the user picked Save/Don't
  // Save, or after a programmatic dispose) so the dispose hook doesn't loop.
  private finalizing = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = renderCircuitHtml(this.panel, this.extensionUri);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg).catch((err) => {
        this.panel.webview.postMessage({ type: "error", message: String(err?.message ?? err) });
      }),
      null, this.disposables,
    );
    this.panel.onDidDispose(() => { void this.handleDispose(); }, null, this.disposables);
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
      case "dirty":
        this.isDirty = !!msg.payload;
        this.panel.title = msg.payload ? "Circuit Editor •" : "Circuit Editor";
        return;
      case "docSync":
        this.cachedDoc = msg.payload as CircuitDoc;
        return;
    }
  }

  /**
   * Webview panels can't veto disposal, so we react after the fact: if the
   * doc was dirty when the user closed the tab, we either save it, drop it,
   * or reopen the panel with the latest state. Cancel (escape) preserves
   * work — the panel is recreated and re-seeded as still-dirty so the next
   * close attempt re-prompts.
   */
  private async handleDispose(): Promise<void> {
    CircuitEditor.instances = CircuitEditor.instances.filter((e) => e !== this);
    if (this.finalizing || !this.isDirty || !this.cachedDoc) {
      this.disposeNow();
      return;
    }

    const doc = this.cachedDoc;
    const currentPath = this.currentPath;
    const label = currentPath ? path.basename(currentPath.fsPath) : (doc.moduleName || "untitled");
    const choice = await vscode.window.showWarningMessage(
      `Save changes to "${label}" before closing?`,
      { modal: true, detail: "Your changes will be lost if you don't save them." },
      "Save", "Don't Save",
    );

    if (choice === "Save") {
      try { await this.save(doc, false); } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to save circuit: ${err?.message ?? err}`);
        CircuitEditor.reopen(this.extensionUri, currentPath, doc);
        this.disposeNow();
        return;
      }
      this.disposeNow();
    } else if (choice === "Don't Save") {
      this.disposeNow();
    } else {
      // Cancel — reopen a fresh panel pre-loaded with the unsaved state.
      CircuitEditor.reopen(this.extensionUri, currentPath, doc);
      this.disposeNow();
    }
  }

  private disposeNow(): void {
    this.finalizing = true;
    for (const d of this.disposables) { d.dispose(); }
  }

  private static reopen(extensionUri: vscode.Uri, currentPath: vscode.Uri | undefined, doc: CircuitDoc): void {
    const panel = CircuitEditor.createPanel(extensionUri);
    const editor = new CircuitEditor(panel, extensionUri);
    CircuitEditor.instances.push(editor);
    editor.currentPath = currentPath;
    editor.cachedDoc = doc;
    editor.isDirty = true;
    editor.panel.title = "Circuit Editor •";
    editor.panel.webview.postMessage({
      type: "loaded",
      payload: doc,
      path: currentPath?.fsPath,
      dirty: true,
    });
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
        "All HDL": ["v", "vh", "sv", "svh", "vhd", "vhdl"],
        "Verilog": ["v", "vh"],
        "SystemVerilog": ["sv", "svh"],
        "VHDL": ["vhd", "vhdl"],
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
    this.finalizing = true;
    CircuitEditor.instances = CircuitEditor.instances.filter((e) => e !== this);
    for (const d of this.disposables) { d.dispose(); }
  }
}
