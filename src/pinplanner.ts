/**
 * pinplanner.ts
 * ----------------------------------------------------------------------------
 * Webview-based pin assignment editor — the closest analogue we have to
 * Vivado's Pin Planner / Quartus's Pin Planner. Reads the top module's
 * port list, lets the user enter a device pin per port, persists the
 * mapping into `bitstream.json` (under `pin_map`), and emits a vendor-
 * appropriate constraint file:
 *
 *   • Xilinx → `constraints/<top>_pins.xdc` with `set_property PACKAGE_PIN`
 *   • Intel  → `constraints/<top>_pins.qsf` with `set_location_assignment`
 *
 * Constraint file generation is destructive (overwrites the named file)
 * but additive at the manifest level — the file is auto-added to
 * `constraints` on first generation.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
    BitstreamManifest, manifestExists, readManifest, writeManifest,
} from "./manifest";
import { ModulePort, parseWorkspaceModules } from "./hierarchy";

interface PinRow {
    port: string;
    direction: string;
    width: number;
    pin: string;
}

export class PinPlanner {
    public static readonly viewType = "bitstream.pinPlanner";
    private static current: PinPlanner | undefined;

    public static show(extensionUri: vscode.Uri, workspaceRoot: string): void {
        if (PinPlanner.current) { PinPlanner.current.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel(
            PinPlanner.viewType, "Pin Planner", vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
        );
        PinPlanner.current = new PinPlanner(panel, workspaceRoot);
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly workspaceRoot: string;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string) {
        this.panel = panel;
        this.workspaceRoot = workspaceRoot;
        this.panel.webview.html = this.renderHtml();
        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handle(msg).catch((err) => {
                this.panel.webview.postMessage({ type: "error", message: String(err?.message ?? err) });
            }),
            null, this.disposables,
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.pushSnapshot();
    }

    /**
     * Read manifest + parse sources to get the current top module's port
     * list, merge with the existing pin_map, and ship the table to the
     * webview. Called on open and after any host-driven save so the UI
     * stays consistent with the file.
     */
    private pushSnapshot(): void {
        if (!manifestExists(this.workspaceRoot)) {
            this.panel.webview.postMessage({ type: "error", message: "bitstream.json not found." });
            return;
        }
        const manifest = readManifest(this.workspaceRoot);
        if (!manifest.top_module) {
            this.panel.webview.postMessage({
                type: "state",
                payload: { vendor: manifest.vendor, top: undefined, rows: [] },
            });
            return;
        }
        const decls = parseWorkspaceModules(this.workspaceRoot, manifest.source_files);
        const top = decls.find((d) => d.name === manifest.top_module);
        const rows: PinRow[] = (top?.ports ?? []).map((p: ModulePort) => ({
            port: p.name,
            direction: p.direction,
            width: p.width,
            pin: manifest.pin_map?.[p.name] ?? "",
        }));
        this.panel.webview.postMessage({
            type: "state",
            payload: { vendor: manifest.vendor, top: manifest.top_module, rows },
        });
    }

    private async handle(msg: any): Promise<void> {
        switch (msg?.type) {
            case "save":     return this.save(msg.rows as PinRow[]);
            case "generate": return this.save(msg.rows as PinRow[], /* generate */ true);
            case "refresh":  return this.pushSnapshot();
        }
    }

    private async save(rows: PinRow[], generate = false): Promise<void> {
        const manifest = readManifest(this.workspaceRoot);
        const pin_map: Record<string, string> = {};
        for (const r of rows) {
            const pin = (r.pin || "").trim();
            if (pin) { pin_map[r.port] = pin; }
        }
        manifest.pin_map = pin_map;
        writeManifest(this.workspaceRoot, manifest);

        if (generate) {
            const constraintRel = await this.emitConstraintFile(manifest, pin_map);
            // Ensure the new file is tracked. We don't auto-sync from the
            // watcher here — the manifest watcher will pick it up — but for
            // immediate feedback we add it now.
            if (constraintRel && !manifest.constraints.includes(constraintRel)) {
                manifest.constraints.push(constraintRel);
                writeManifest(this.workspaceRoot, manifest);
            }
            this.panel.webview.postMessage({ type: "info", message: `Generated ${constraintRel}` });
            vscode.window.showInformationMessage(`Pin constraints written: ${constraintRel}`);
        } else {
            this.panel.webview.postMessage({ type: "info", message: "Pin map saved." });
        }
    }

    /**
     * Write the vendor-appropriate constraint file. Pin specifiers are passed
     * through verbatim — users put `W5` or `PIN_AB7` in the cell exactly as
     * the vendor expects, no normalization.
     */
    private async emitConstraintFile(manifest: BitstreamManifest, pin_map: Record<string, string>): Promise<string> {
        const top = manifest.top_module || "top";
        const constraintsDir = path.join(this.workspaceRoot, "constraints");
        if (!fs.existsSync(constraintsDir)) { fs.mkdirSync(constraintsDir, { recursive: true }); }

        if (manifest.vendor === "xilinx") {
            const file = `constraints/${top}_pins.xdc`;
            const lines: string[] = [];
            lines.push(`# Auto-generated by Bitstream Pin Planner.`);
            for (const [port, pin] of Object.entries(pin_map)) {
                lines.push(`set_property PACKAGE_PIN ${pin} [get_ports ${port}]`);
                // Default to LVCMOS33 — users can change after generation.
                lines.push(`set_property IOSTANDARD LVCMOS33 [get_ports ${port}]`);
            }
            fs.writeFileSync(path.join(this.workspaceRoot, file), lines.join("\n") + "\n", "utf8");
            return file;
        } else {
            const file = `constraints/${top}_pins.qsf`;
            const lines: string[] = [];
            lines.push(`# Auto-generated by Bitstream Pin Planner.`);
            for (const [port, pin] of Object.entries(pin_map)) {
                // Quartus uses PIN_xxx; we accept both `PIN_W5` and `W5` in the cell.
                const norm = pin.startsWith("PIN_") ? pin : `PIN_${pin}`;
                lines.push(`set_location_assignment ${norm} -to ${port}`);
            }
            fs.writeFileSync(path.join(this.workspaceRoot, file), lines.join("\n") + "\n", "utf8");
            return file;
        }
    }

    public dispose(): void {
        PinPlanner.current = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }

    private renderHtml(): string {
        const nonce = randomNonce();
        const csp = [
            `default-src 'none'`,
            `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join("; ");
        return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Pin Planner</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
  .sub { opacity: 0.7; font-size: 0.85rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
  th { background: var(--vscode-editorWidget-background); font-weight: normal; opacity: 0.85; }
  td.port { font-family: var(--vscode-editor-font-family, monospace); }
  td.dir.input { color: var(--vscode-charts-green, #6fcf97); }
  td.dir.output { color: var(--vscode-charts-orange, #f2994a); }
  td.dir.inout  { color: var(--vscode-charts-purple, #bb86fc); }
  input.pin { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 0.25rem 0.4rem; font-family: var(--vscode-editor-font-family, monospace); }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; align-items: center; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 0.4rem 0.9rem; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.ghost { background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
  .status { opacity: 0.7; font-size: 0.85rem; }
  .empty { padding: 2rem 1rem; opacity: 0.7; text-align: center; }
</style>
</head><body>
<h1>Pin Planner</h1>
<div class="sub" id="sub">…</div>
<div id="content">Loading…</div>
<div class="actions">
  <button id="btnSave">Save Pin Map</button>
  <button id="btnGenerate">Generate Constraint File</button>
  <button id="btnRefresh" class="ghost">Refresh from Sources</button>
  <span class="status" id="status"></span>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const content = document.getElementById('content');
const sub = document.getElementById('sub');
const status = document.getElementById('status');
let state = { vendor: 'xilinx', top: undefined, rows: [] };

function render() {
  sub.textContent = state.top
    ? 'Top module: ' + state.top + '  •  vendor: ' + state.vendor
    : 'No top module set in bitstream.json — set one to see ports here.';
  if (!state.rows.length) {
    content.innerHTML = '<div class="empty">' + (state.top
      ? 'Top module "' + state.top + '" has no parsed ports.'
      : 'Run "Bitstream: Set Top Module" to begin.') + '</div>';
    return;
  }
  const placeholder = state.vendor === 'xilinx' ? 'e.g. W5' : 'e.g. PIN_AB7';
  const rows = state.rows.map((r, i) => (
    '<tr>' +
      '<td class="port">' + escapeHtml(r.port) + '</td>' +
      '<td class="dir ' + r.direction + '">' + r.direction + '</td>' +
      '<td>' + (r.width > 1 ? '[' + r.width + ']' : '1') + '</td>' +
      '<td><input class="pin" data-index="' + i + '" value="' + escapeHtml(r.pin) + '" placeholder="' + placeholder + '" /></td>' +
    '</tr>'
  )).join('');
  content.innerHTML =
    '<table><thead><tr><th>Port</th><th>Direction</th><th>Width</th><th>Device pin</th></tr></thead><tbody>' +
    rows + '</tbody></table>';
  content.querySelectorAll('input.pin').forEach((el) => {
    el.addEventListener('input', () => {
      state.rows[parseInt(el.dataset.index, 10)].pin = el.value;
    });
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\\'':'&#39;'}[c])); }

document.getElementById('btnSave').addEventListener('click', () => vscode.postMessage({ type: 'save', rows: state.rows }));
document.getElementById('btnGenerate').addEventListener('click', () => vscode.postMessage({ type: 'generate', rows: state.rows }));
document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') { state = msg.payload || state; render(); }
  else if (msg.type === 'info') { status.textContent = msg.message; setTimeout(() => { status.textContent = ''; }, 2500); }
  else if (msg.type === 'error') { status.textContent = msg.message; }
});
</script>
</body></html>`;
    }
}

function randomNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return s;
}
