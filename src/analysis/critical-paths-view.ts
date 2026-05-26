/**
 * critical-paths-view.ts
 * ----------------------------------------------------------------------------
 * Webview that renders the worst N timing paths from `CriticalPathsReport`,
 * each expandable into its step-by-step delay table. Every endpoint
 * (source / destination / per-step resource) is a link — clicking it
 * resolves the netlist name back to an RTL declaration and opens the
 * file at the right line.
 *
 * Source resolution lives in critical-paths.ts and is intentionally
 * best-effort: when we can't pin the endpoint to a line we just open
 * the most likely file at line 1 rather than failing silently.
 */

import * as vscode from "vscode";
import * as path from "path";
import { CriticalPathsReport, TimingPath, loadCriticalPaths, resolveEndpoint } from "./critical-paths";
import { readManifest } from "../project/manifest";
import { parseWorkspaceModules } from "../project/hierarchy";

export class CriticalPathsView {
    public static readonly viewType = "bitstream.criticalPaths";
    private static instance: CriticalPathsView | undefined;

    public static show(workspaceRoot: string): void {
        if (CriticalPathsView.instance) {
            CriticalPathsView.instance.panel.reveal(vscode.ViewColumn.Active);
            CriticalPathsView.instance.refresh(workspaceRoot);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            CriticalPathsView.viewType,
            "Critical Paths",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        CriticalPathsView.instance = new CriticalPathsView(panel, workspaceRoot);
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    /** Map of instance name → workspace-relative source file, used by `resolveEndpoint`. */
    private instanceFileMap = new Map<string, string>();
    private sourceFiles: string[] = [];

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "refresh") {
                this.refresh(workspaceRoot);
            } else if (msg?.type === "jump" && typeof msg.endpoint === "string") {
                this.jump(workspaceRoot, msg.endpoint);
            } else if (msg?.type === "openReport") {
                this.openReport(workspaceRoot);
            }
        }, null, this.disposables);
        this.refresh(workspaceRoot);
    }

    private refresh(workspaceRoot: string): void {
        let report: CriticalPathsReport | null = null;
        try {
            const manifest = readManifest(workspaceRoot);
            report = loadCriticalPaths(workspaceRoot, manifest.vendor, manifest.project_name);
            this.sourceFiles = manifest.source_files;
            // Build instance-name → file map by walking parsed modules.
            // Used to bias source resolution toward the module that
            // actually contains the failing register.
            this.instanceFileMap.clear();
            const decls = parseWorkspaceModules(workspaceRoot, manifest.source_files);
            const moduleFile = new Map<string, string>();
            for (const d of decls) { moduleFile.set(d.name, d.file); }
            for (const d of decls) {
                for (const inst of d.instances) {
                    const file = moduleFile.get(inst.type);
                    if (file) { this.instanceFileMap.set(inst.name, file); }
                }
            }
        } catch { /* empty render below */ }
        this.panel.webview.html = renderHtml(workspaceRoot, report);
    }

    private jump(workspaceRoot: string, endpoint: string): void {
        const loc = resolveEndpoint(workspaceRoot, endpoint, this.sourceFiles, this.instanceFileMap);
        if (!loc) {
            vscode.window.showWarningMessage(
                `Bitstream: couldn't map endpoint "${endpoint}" to a source line. ` +
                `Try opening one of the project sources manually.`,
            );
            return;
        }
        const uri = vscode.Uri.file(path.join(workspaceRoot, loc.file));
        const pos = new vscode.Position(Math.max(0, loc.line - 1), 0);
        vscode.window.showTextDocument(uri, {
            preview: false,
            selection: new vscode.Range(pos, pos),
        });
    }

    private openReport(workspaceRoot: string): void {
        try {
            const manifest = readManifest(workspaceRoot);
            const report = loadCriticalPaths(workspaceRoot, manifest.vendor, manifest.project_name);
            if (report) {
                vscode.window.showTextDocument(vscode.Uri.file(report.source_file), { preview: false });
            }
        } catch { /* ignore */ }
    }

    public dispose(): void {
        CriticalPathsView.instance = undefined;
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderHtml(workspaceRoot: string, report: CriticalPathsReport | null): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const body = report ? renderReport(workspaceRoot, report) : renderEmpty();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Critical Paths</title>
<style>
  :root {
    --good: var(--vscode-testing-iconPassed, #4caf50);
    --warn: var(--vscode-charts-orange, #d18616);
    --bad:  var(--vscode-testing-iconFailed, #e53935);
  }
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .wrap { padding: 1rem 1.25rem; max-width: 1100px; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
  .sub { font-size: 0.8rem; opacity: 0.65; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.8rem; margin-left: 0.4rem; }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .empty { padding: 3rem 1rem; text-align: center; opacity: 0.7; }
  .empty .hint { font-size: 0.85rem; margin-top: 0.5rem; }
  details.path { border: 1px solid var(--vscode-panel-border); border-radius: 3px; margin: 0.4rem 0; background: var(--vscode-editor-inactiveSelectionBackground); }
  details.path[open] { background: var(--vscode-editor-background); }
  summary { padding: 0.6rem 0.8rem; cursor: pointer; display: grid; grid-template-columns: auto 1fr auto; gap: 0.8rem; align-items: center; font-size: 0.85rem; }
  summary::-webkit-details-marker { display: none; }
  .rank { font-variant-numeric: tabular-nums; font-size: 0.75rem; opacity: 0.55; min-width: 1.5rem; }
  .slack { font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
  .slack.bad { color: var(--bad); }
  .slack.warn { color: var(--warn); }
  .slack.ok { color: var(--good); }
  .endpoints { font-size: 0.78rem; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .endpoints .arrow { opacity: 0.5; margin: 0 0.3rem; }
  .meta-row { display: flex; gap: 1rem; flex-wrap: wrap; padding: 0.5rem 0.9rem 0; font-size: 0.78rem; opacity: 0.78; }
  .meta-row .pill { padding: 0.1rem 0.45rem; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
  table.steps { width: 100%; border-collapse: collapse; font-size: 0.78rem; margin: 0.4rem 0 0.6rem; }
  table.steps th, table.steps td { padding: 0.25rem 0.6rem; text-align: left; border-bottom: 1px dotted var(--vscode-panel-border); }
  table.steps th { font-weight: 500; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
  table.steps td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.steps td.resource { font-family: var(--vscode-editor-font-family, monospace); }
  table.steps td.resource a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  table.steps td.resource a:hover { text-decoration: underline; }
  .endpoints a { color: inherit; text-decoration: none; cursor: pointer; }
  .endpoints a:hover { text-decoration: underline; color: var(--vscode-textLink-foreground); }
  .warnings { background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.08)); padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-top: 1rem; border-radius: 2px; }
</style>
</head>
<body>
<div class="wrap">
  ${body}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'refresh' })));
  document.querySelectorAll('[data-open-report]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'openReport' })));
  document.querySelectorAll('a[data-endpoint]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'jump', endpoint: a.dataset.endpoint });
  }));
</script>
</body>
</html>`;
}

function renderEmpty(): string {
    return `<header>
    <h1>Critical Paths</h1>
    <div><button data-refresh>Refresh</button></div>
  </header>
  <div class="empty">
    <div>No per-path timing report found yet.</div>
    <div class="hint">Run <strong>Bitstream: Build Bitstream</strong>. The build emits
    <code>build/&lt;project&gt;_timing_paths.rpt</code> (Vivado) or reads
    <code>quartus_project/output_files/&lt;project&gt;.sta.rpt</code> (Quartus)
    to populate this view.</div>
  </div>`;
}

function renderReport(workspaceRoot: string, r: CriticalPathsReport): string {
    const generated = r.generated_at ? new Date(r.generated_at).toLocaleString() : "unknown";
    const rel = path.relative(workspaceRoot, r.source_file) || r.source_file;
    const worst = r.paths.length ? r.paths.reduce((a, b) => a.slack_ns < b.slack_ns ? a : b) : undefined;
    const worstText = worst ? `Worst slack ${worst.slack_ns.toFixed(3)} ns on ${escapeHtml(worst.path_group ?? "")}` : "No paths parsed";

    const items = r.paths.map((p, i) => renderPath(p, i + 1)).join("");
    const warnings = r.warnings.length
        ? `<div class="warnings">${escapeHtml(r.warnings.join(" · "))}</div>` : "";

    return `<header>
    <div>
      <h1>Critical Paths <span class="sub">— ${escapeHtml(worstText)}</span></h1>
      <div class="sub">Parsed ${r.paths.length} path${r.paths.length === 1 ? "" : "s"} from
      <span title="${escapeAttr(r.source_file)}">${escapeHtml(rel)}</span> · generated ${escapeHtml(generated)}</div>
    </div>
    <div>
      <button class="secondary" data-open-report>Open raw report</button>
      <button data-refresh>Refresh</button>
    </div>
  </header>
  ${items || `<div class="empty">No paths in report.</div>`}
  ${warnings}`;
}

function renderPath(p: TimingPath, rank: number): string {
    const slackCls = p.slack_ns < 0 ? "bad" : p.slack_ns < 0.5 ? "warn" : "ok";
    const meta: string[] = [];
    if (p.path_type) { meta.push(`<span class="pill">${escapeHtml(p.path_type)}</span>`); }
    if (p.path_group) { meta.push(`<span class="pill">Group: ${escapeHtml(p.path_group)}</span>`); }
    if (p.source_clock) { meta.push(`<span class="pill">Src clk: ${escapeHtml(p.source_clock)}</span>`); }
    if (p.dest_clock && p.dest_clock !== p.source_clock) { meta.push(`<span class="pill">Dst clk: ${escapeHtml(p.dest_clock)}</span>`); }
    if (p.requirement_ns != null) { meta.push(`<span class="pill">Req: ${p.requirement_ns.toFixed(3)} ns</span>`); }
    if (p.data_path_delay_ns != null) { meta.push(`<span class="pill">Data delay: ${p.data_path_delay_ns.toFixed(3)} ns</span>`); }
    if (p.logic_levels != null) { meta.push(`<span class="pill">Levels: ${p.logic_levels}</span>`); }

    const rows = p.points.map((pt) => `<tr>
        <td class="num">${pt.cum_ns != null ? pt.cum_ns.toFixed(3) : ""}</td>
        <td class="num">${pt.incr_ns != null ? pt.incr_ns.toFixed(3) : ""}</td>
        <td>${escapeHtml(pt.delay_type ?? "")}</td>
        <td>${escapeHtml(pt.location ?? "")}</td>
        <td class="resource"><a data-endpoint="${escapeAttr(pt.resource)}" title="Jump to RTL source">${escapeHtml(pt.resource)}</a></td>
      </tr>`).join("");

    const table = p.points.length ? `<table class="steps">
        <thead><tr>
          <th class="num">Path (ns)</th>
          <th class="num">Incr (ns)</th>
          <th>Delay type</th>
          <th>Location</th>
          <th>Netlist resource</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="sub" style="padding: 0.4rem 0.9rem 0.6rem;">No per-step delay rows in report.</div>`;

    return `<details class="path"${rank === 1 ? " open" : ""}>
      <summary>
        <span class="rank">#${rank}</span>
        <span class="endpoints">
          <a data-endpoint="${escapeAttr(p.source)}" title="Jump to source register">${escapeHtml(p.source)}</a>
          <span class="arrow">→</span>
          <a data-endpoint="${escapeAttr(p.destination)}" title="Jump to destination register">${escapeHtml(p.destination)}</a>
        </span>
        <span class="slack ${slackCls}">${p.slack_ns >= 0 ? "+" : ""}${p.slack_ns.toFixed(3)} ns</span>
      </summary>
      <div class="meta-row">${meta.join("")}</div>
      ${table}
    </details>`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string { return escapeHtml(s); }

function randomNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return s;
}
