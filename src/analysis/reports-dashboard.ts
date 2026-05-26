/**
 * reports-dashboard.ts
 * ----------------------------------------------------------------------------
 * Webview that visualises a parsed BuildReport: utilization bars per
 * resource, a per-clock table with WNS/TNS/Fmax, and a header summary of the
 * worst slack across the design.
 *
 * The panel is a singleton (we reveal the existing one instead of stacking
 * new tabs) and refreshes either on demand or right after a build completes
 * (see Toolchain.build).
 */

import * as vscode from "vscode";
import * as path from "path";
import { BuildReport, loadBuildReport } from "./reports";
import { readManifest } from "../project/manifest";

export class ReportsDashboard {
    public static readonly viewType = "bitstream.reportsDashboard";
    private static instance: ReportsDashboard | undefined;

    /**
     * Reveal the panel, creating it if needed. If `report` is omitted we
     * (re)load from disk for the current workspace — used by both the
     * command and the post-build hook.
     */
    public static show(workspaceRoot: string, report?: BuildReport | null): void {
        const r = report !== undefined ? report : ReportsDashboard.loadCurrent(workspaceRoot);
        if (ReportsDashboard.instance) {
            ReportsDashboard.instance.panel.reveal(vscode.ViewColumn.Active);
            ReportsDashboard.instance.update(workspaceRoot, r);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ReportsDashboard.viewType,
            "Resource & Timing",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        ReportsDashboard.instance = new ReportsDashboard(panel, workspaceRoot, r);
    }

    /** Post-build entry point: only opens the panel if a report exists. */
    public static refreshAfterBuild(workspaceRoot: string): void {
        const r = ReportsDashboard.loadCurrent(workspaceRoot);
        if (!r) { return; }
        ReportsDashboard.show(workspaceRoot, r);
    }

    private static loadCurrent(workspaceRoot: string): BuildReport | null {
        try {
            const manifest = readManifest(workspaceRoot);
            return loadBuildReport(workspaceRoot, manifest.vendor, manifest.project_name);
        } catch {
            return null;
        }
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string, report: BuildReport | null) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "refresh") {
                this.update(workspaceRoot, ReportsDashboard.loadCurrent(workspaceRoot));
            } else if (msg?.type === "openSource" && typeof msg.path === "string") {
                vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: false });
            }
        }, null, this.disposables);
        this.update(workspaceRoot, report);
    }

    private update(workspaceRoot: string, report: BuildReport | null): void {
        this.panel.webview.html = renderDashboardHtml(workspaceRoot, report);
    }

    public dispose(): void {
        ReportsDashboard.instance = undefined;
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// HTML rendering — server-side template (no script needed beyond the
// refresh/open-source bridge), so we keep it as a plain string builder.
// ---------------------------------------------------------------------------

function renderDashboardHtml(workspaceRoot: string, report: BuildReport | null): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    const body = report ? renderReport(workspaceRoot, report) : renderEmpty();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Resource &amp; Timing</title>
<style>
  :root {
    --good: var(--vscode-testing-iconPassed, #4caf50);
    --warn: var(--vscode-charts-orange, #d18616);
    --bad:  var(--vscode-testing-iconFailed, #e53935);
    --bar-bg: var(--vscode-editor-inactiveSelectionBackground);
  }
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .wrap { padding: 1rem 1.25rem; max-width: 980px; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 1.5rem 0 0.5rem; opacity: 0.75; }
  .sub { font-size: 0.8rem; opacity: 0.65; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.8rem; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .empty { padding: 3rem 1rem; text-align: center; opacity: 0.7; }
  .empty .hint { font-size: 0.85rem; margin-top: 0.5rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .card { padding: 0.75rem 0.9rem; background: var(--vscode-editor-inactiveSelectionBackground); border-left: 3px solid var(--vscode-panel-border); border-radius: 2px; }
  .card .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; }
  .card .value { font-size: 1.3rem; font-weight: 500; margin-top: 0.2rem; font-variant-numeric: tabular-nums; }
  .card .note { font-size: 0.7rem; opacity: 0.55; margin-top: 0.15rem; }
  .card.ok   { border-left-color: var(--good); }
  .card.warn { border-left-color: var(--warn); }
  .card.bad  { border-left-color: var(--bad); }
  .res-row { display: grid; grid-template-columns: 80px 1fr 140px; gap: 0.6rem; align-items: center; margin: 0.4rem 0; }
  .res-row .name { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85rem; }
  .res-row .numbers { font-size: 0.8rem; opacity: 0.75; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { position: relative; height: 14px; background: var(--bar-bg); border-radius: 2px; overflow: hidden; }
  .bar > .fill { height: 100%; transition: width 0.2s; }
  .fill.ok   { background: var(--good); }
  .fill.warn { background: var(--warn); }
  .fill.bad  { background: var(--bad); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
  th { font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family, monospace); }
  td.slack-bad  { color: var(--bad); font-weight: 600; }
  td.slack-warn { color: var(--warn); }
  td.slack-ok   { color: var(--good); }
  ul.sources { list-style: none; padding: 0; margin: 0.5rem 0 0; }
  ul.sources li { font-size: 0.78rem; padding: 0.2rem 0; opacity: 0.85; }
  ul.sources a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  ul.sources a:hover { text-decoration: underline; }
  .warnings { background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, 0.08)); border: 1px solid var(--vscode-inputValidation-warningBorder, transparent); padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-top: 1rem; border-radius: 2px; }
</style>
</head>
<body>
<div class="wrap">
  ${body}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'refresh' })));
  document.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'openSource', path: a.dataset.open });
  }));
</script>
</body>
</html>`;
}

function renderEmpty(): string {
    return `<header>
    <h1>Resource &amp; Timing</h1>
    <button data-refresh>Refresh</button>
  </header>
  <div class="empty">
    <div>No build reports found yet.</div>
    <div class="hint">Run <strong>Bitstream: Build Bitstream</strong> — the dashboard will populate from
    the utilization and timing reports the toolchain emits.</div>
  </div>`;
}

function renderReport(workspaceRoot: string, r: BuildReport): string {
    const summary = buildSummaryCards(r);
    const resources = renderResources(r);
    const clocks = renderClocks(r);
    const sources = renderSources(workspaceRoot, r);
    const warnings = r.warnings.length ? `<div class="warnings">${escapeHtml(r.warnings.join(" · "))}</div>` : "";
    const generated = r.generated_at ? new Date(r.generated_at).toLocaleString() : "unknown";
    const vendorLabel = r.vendor === "xilinx" ? "Vivado" : "Quartus";
    const deviceLine = r.device ? ` · ${escapeHtml(r.device)}` : "";
    return `<header>
    <div>
      <h1>${escapeHtml(r.project_name)} <span class="sub">— ${vendorLabel}${deviceLine}</span></h1>
      <div class="sub">Reports generated ${escapeHtml(generated)}</div>
    </div>
    <button data-refresh>Refresh</button>
  </header>
  ${summary}
  <h2>Utilization</h2>
  ${resources}
  <h2>Timing</h2>
  ${clocks}
  <h2>Source files</h2>
  ${sources}
  ${warnings}`;
}

// ---- Summary header cards --------------------------------------------------

function buildSummaryCards(r: BuildReport): string {
    const cards: string[] = [];

    // Worst slack across all clocks (setup).
    let worstSlack: number | undefined;
    let worstClock: string | undefined;
    for (const c of r.clocks) {
        if (c.wns_ns == null) { continue; }
        if (worstSlack === undefined || c.wns_ns < worstSlack) {
            worstSlack = c.wns_ns;
            worstClock = c.name;
        }
    }
    if (worstSlack !== undefined) {
        const cls = worstSlack < 0 ? "bad" : worstSlack < 0.5 ? "warn" : "ok";
        cards.push(card("Worst Setup Slack", `${formatNs(worstSlack)} ns`, worstClock ?? "", cls));
    }

    // Best Fmax we can quote — pick the maximum across clocks.
    let bestFmax: number | undefined;
    let bestFmaxClock: string | undefined;
    for (const c of r.clocks) {
        if (c.fmax_mhz == null) { continue; }
        if (bestFmax === undefined || c.fmax_mhz > bestFmax) {
            bestFmax = c.fmax_mhz;
            bestFmaxClock = c.name;
        }
    }
    if (bestFmax !== undefined) {
        cards.push(card("Best Fmax", `${bestFmax.toFixed(2)} MHz`, bestFmaxClock ?? "", "ok"));
    }

    // Headline LUT% so the user has a single resource glance.
    const lut = r.resources.find((x) => x.name === "LUT");
    if (lut) {
        cards.push(card("LUT Utilization",
            `${lut.percent.toFixed(1)}%`,
            `${formatInt(lut.used)} / ${formatInt(lut.available)}`,
            severityClass(lut.percent)));
    }

    if (!cards.length) {
        cards.push(card("Status", "Reports parsed", "Detailed numbers below", "ok"));
    }
    return `<section class="summary">${cards.join("")}</section>`;
}

function card(label: string, value: string, note: string, cls: string): string {
    return `<div class="card ${cls}">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="note">${escapeHtml(note)}</div>
    </div>`;
}

// ---- Resource bars ---------------------------------------------------------

function renderResources(r: BuildReport): string {
    if (!r.resources.length) {
        return `<p class="sub">No utilization rows parsed. Check the source files below.</p>`;
    }
    const rows = r.resources.map((m) => {
        const cls = severityClass(m.percent);
        const pct = Math.max(0, Math.min(100, m.percent));
        const denom = m.available > 0 ? `${formatInt(m.used)} / ${formatInt(m.available)} (${m.percent.toFixed(1)}%)` : `${formatInt(m.used)}`;
        return `<div class="res-row">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="bar"><div class="fill ${cls}" style="width:${pct.toFixed(2)}%"></div></div>
          <div class="numbers">${escapeHtml(denom)}</div>
        </div>`;
    }).join("");
    return rows;
}

// ---- Per-clock timing table ------------------------------------------------

function renderClocks(r: BuildReport): string {
    if (!r.clocks.length) {
        return `<p class="sub">No timing rows parsed. Check the source files below.</p>`;
    }
    const rows = r.clocks.map((c) => {
        const wns = formatSlackCell(c.wns_ns);
        const tns = formatSlackCell(c.tns_ns);
        const whs = formatSlackCell(c.whs_ns);
        const ths = formatSlackCell(c.ths_ns);
        const fmax = c.fmax_mhz != null ? `${c.fmax_mhz.toFixed(2)} MHz` : "—";
        return `<tr>
          <td>${escapeHtml(c.name)}</td>
          <td class="num ${wns.cls}">${wns.text}</td>
          <td class="num ${tns.cls}">${tns.text}</td>
          <td class="num ${whs.cls}">${whs.text}</td>
          <td class="num ${ths.cls}">${ths.text}</td>
          <td class="num">${escapeHtml(fmax)}</td>
        </tr>`;
    }).join("");
    return `<table>
      <thead><tr>
        <th>Clock</th>
        <th class="num">WNS (ns)</th>
        <th class="num">TNS (ns)</th>
        <th class="num">WHS (ns)</th>
        <th class="num">THS (ns)</th>
        <th class="num">Fmax</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---- Source list -----------------------------------------------------------

function renderSources(workspaceRoot: string, r: BuildReport): string {
    const items = r.sources.map((p) => {
        const rel = path.relative(workspaceRoot, p) || p;
        return `<li><a data-open="${escapeAttr(p)}">${escapeHtml(rel)}</a></li>`;
    }).join("");
    return `<ul class="sources">${items}</ul>`;
}

// ---- Formatting helpers ----------------------------------------------------

function severityClass(percentUsed: number): string {
    if (percentUsed >= 90) { return "bad"; }
    if (percentUsed >= 70) { return "warn"; }
    return "ok";
}

function formatInt(n: number): string {
    if (!Number.isFinite(n)) { return "—"; }
    return Math.round(n).toLocaleString();
}

function formatNs(n: number): string {
    return n.toFixed(3);
}

function formatSlackCell(ns: number | undefined): { text: string; cls: string } {
    if (ns == null || !Number.isFinite(ns)) { return { text: "—", cls: "" }; }
    const cls = ns < 0 ? "slack-bad" : ns < 0.5 ? "slack-warn" : "slack-ok";
    return { text: ns.toFixed(3), cls };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
    return escapeHtml(s);
}

function randomNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return s;
}
