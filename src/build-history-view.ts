/**
 * build-history-view.ts
 * ----------------------------------------------------------------------------
 * Webview that visualises `.bitstream/history.json`. Two panels:
 *
 *   1. Sparkline header — one SVG mini-chart per tracked metric (LUT %,
 *      FF %, BRAM %, DSP %, WNS, Fmax). Each chart shows the trend across
 *      all entries with a coloured baseline for "good" / "bad" regions
 *      (above-budget utilisation is red; negative slack is red).
 *
 *   2. Entry table — one row per build, newest first. Cells show the
 *      delta vs the previous entry alongside the absolute number so a
 *      regression jumps out at a glance.
 *
 * Everything renders server-side as HTML/SVG — no charting library, no
 * runtime data crunching in the webview.
 */

import * as vscode from "vscode";
import { HistoryEntry, loadHistory } from "./build-history";

export class BuildHistoryView {
    public static readonly viewType = "bitstream.buildHistory";
    private static instance: BuildHistoryView | undefined;

    public static show(workspaceRoot: string): void {
        if (BuildHistoryView.instance) {
            BuildHistoryView.instance.panel.reveal(vscode.ViewColumn.Active);
            BuildHistoryView.instance.refresh(workspaceRoot);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            BuildHistoryView.viewType,
            "Build History",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        BuildHistoryView.instance = new BuildHistoryView(panel, workspaceRoot);
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "refresh") { this.refresh(workspaceRoot); }
        }, null, this.disposables);
        this.refresh(workspaceRoot);
    }

    private refresh(workspaceRoot: string): void {
        const entries = loadHistory(workspaceRoot);
        this.panel.webview.html = renderHtml(entries);
    }

    public dispose(): void {
        BuildHistoryView.instance = undefined;
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderHtml(entries: HistoryEntry[]): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const body = entries.length ? renderHistory(entries) : renderEmpty();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Build History</title>
<style>
  :root {
    --good: var(--vscode-testing-iconPassed, #4caf50);
    --warn: var(--vscode-charts-orange, #d18616);
    --bad:  var(--vscode-testing-iconFailed, #e53935);
    --grid: var(--vscode-panel-border);
  }
  html, body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .wrap { padding: 1rem 1.25rem; max-width: 1180px; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
  h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 1.4rem 0 0.5rem; opacity: 0.75; }
  .sub { font-size: 0.8rem; opacity: 0.65; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 0.3rem 0.8rem; cursor: pointer; font-size: 0.8rem; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .empty { padding: 3rem 1rem; text-align: center; opacity: 0.7; }
  .empty .hint { font-size: 0.85rem; margin-top: 0.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .spark { padding: 0.55rem 0.7rem; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; }
  .spark .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; }
  .spark .value { font-size: 1.05rem; font-variant-numeric: tabular-nums; font-weight: 500; margin-top: 0.1rem; }
  .spark .delta { font-size: 0.7rem; margin-left: 0.4rem; font-variant-numeric: tabular-nums; }
  .delta.up.bad { color: var(--bad); }
  .delta.up.ok  { color: var(--good); }
  .delta.down.bad { color: var(--bad); }
  .delta.down.ok  { color: var(--good); }
  .spark svg { display: block; margin-top: 0.25rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.78rem; margin-top: 0.5rem; }
  th, td { padding: 0.35rem 0.55rem; text-align: left; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  th { font-weight: 500; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family, monospace); }
  td.commit { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.75rem; }
  td.subject { max-width: 320px; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
  td .delta { font-size: 0.7rem; margin-left: 0.35rem; opacity: 0.85; }
  td .delta.bad { color: var(--bad); }
  td .delta.ok  { color: var(--good); }
  .dirty-tag { font-size: 0.65rem; padding: 0.05rem 0.3rem; border: 1px solid var(--warn); color: var(--warn); border-radius: 6px; margin-left: 0.35rem; vertical-align: middle; }
</style>
</head>
<body>
<div class="wrap">
  ${body}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'refresh' })));
</script>
</body>
</html>`;
}

function renderEmpty(): string {
    return `<header>
    <h1>Build History</h1>
    <div><button data-refresh>Refresh</button></div>
  </header>
  <div class="empty">
    <div>No build history yet.</div>
    <div class="hint">Run <strong>Bitstream: Build Bitstream</strong>. Each successful build appends a
    snapshot to <code>.bitstream/history.json</code> — commit it to git to share trends across the team.</div>
  </div>`;
}

function renderHistory(entries: HistoryEntry[]): string {
    const latest = entries[entries.length - 1];
    const sparks = renderSparks(entries);
    const table = renderTable(entries);
    const subtitle = `${entries.length} build${entries.length === 1 ? "" : "s"} recorded · latest ${formatTime(latest.timestamp)}`;
    return `<header>
    <div>
      <h1>Build History <span class="sub">— ${escapeHtml(latest.project_name)}</span></h1>
      <div class="sub">${escapeHtml(subtitle)}</div>
    </div>
    <div><button data-refresh>Refresh</button></div>
  </header>
  <h2>Trends</h2>
  <section class="grid">${sparks}</section>
  <h2>Per-build detail</h2>
  ${table}`;
}

// ---- Sparkline cards -------------------------------------------------------

interface SeriesSpec {
    label: string;
    extract: (e: HistoryEntry) => number | undefined;
    format: (n: number) => string;
    /** When true, a *rising* line is bad (e.g. utilisation %, neg slack rising toward 0 is fine but anything >threshold = bad). */
    risingIsBad: boolean;
    /** Optional zero-crossing band: values below this are bad (used for WNS). */
    badBelow?: number;
}

function seriesSpecs(): SeriesSpec[] {
    return [
        ...(["LUT", "FF", "BRAM", "DSP"] as const).map((res): SeriesSpec => ({
            label: `${res} %`,
            extract: (e) => e.resources.find((r) => r.name === res)?.percent,
            format: (n) => `${n.toFixed(1)}%`,
            risingIsBad: true,
        })),
        { label: "Worst WNS (ns)", extract: (e) => e.worst_wns_ns, format: (n) => `${n.toFixed(3)} ns`,
          risingIsBad: false, badBelow: 0 },
        { label: "Best Fmax (MHz)", extract: (e) => e.best_fmax_mhz, format: (n) => `${n.toFixed(1)} MHz`,
          risingIsBad: false },
    ];
}

function renderSparks(entries: HistoryEntry[]): string {
    return seriesSpecs()
        .map((spec) => renderSpark(spec, entries))
        .filter(Boolean)
        .join("");
}

function renderSpark(spec: SeriesSpec, entries: HistoryEntry[]): string {
    const values: number[] = [];
    for (const e of entries) {
        const v = spec.extract(e);
        if (typeof v === "number" && Number.isFinite(v)) { values.push(v); }
        else { values.push(NaN); }
    }
    const valid = values.filter((v) => Number.isFinite(v));
    if (!valid.length) { return ""; }
    const latest = valid[valid.length - 1];
    const previous = valid.length > 1 ? valid[valid.length - 2] : undefined;

    const delta = previous !== undefined ? latest - previous : 0;
    const deltaCls = previous === undefined
        ? ""
        : (delta === 0
            ? ""
            : ((delta > 0) === spec.risingIsBad ? "up bad" : (delta > 0 ? "up ok" : "down ok")));
    const deltaText = previous === undefined
        ? ""
        : (delta === 0 ? "·" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(spec.label.includes("%") ? 2 : 3)}`);

    const svg = sparklineSvg(values, spec);
    return `<div class="spark">
      <div class="label">${escapeHtml(spec.label)}</div>
      <div class="value">${escapeHtml(spec.format(latest))}<span class="delta ${deltaCls}">${escapeHtml(deltaText)}</span></div>
      ${svg}
    </div>`;
}

/**
 * Render a tiny SVG sparkline. NaN points break the polyline into segments
 * so missing data shows as a gap instead of a misleading interpolation.
 * The plot area is fixed-width; the X axis just indexes builds.
 */
function sparklineSvg(values: number[], spec: SeriesSpec): string {
    const W = 200, H = 36, PAD = 2;
    const finite = values.filter((v) => Number.isFinite(v));
    let min = Math.min(...finite);
    let max = Math.max(...finite);
    if (min === max) { min -= 1; max += 1; }
    // For % series the y-range is meaningful in absolute terms — pad it
    // so a flat-100% line doesn't reach the very top of the chart.
    if (spec.label.includes("%")) {
        min = Math.min(min, 0);
        max = Math.max(max, min + 5);
    }
    const xStep = values.length > 1 ? (W - 2 * PAD) / (values.length - 1) : 0;
    const yFor = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);

    // Bad-band shading (e.g. negative WNS).
    let band = "";
    if (spec.badBelow !== undefined && spec.badBelow >= min && spec.badBelow <= max) {
        const yZero = yFor(spec.badBelow);
        band = `<rect x="0" y="${yZero}" width="${W}" height="${H - yZero}" fill="var(--bad)" opacity="0.08" />`;
    }

    // Build poly-segments at NaN boundaries.
    const segments: string[] = [];
    let cur: string[] = [];
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) {
            if (cur.length) { segments.push(cur.join(" ")); cur = []; }
            continue;
        }
        const x = PAD + i * xStep;
        const y = yFor(values[i]);
        cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    if (cur.length) { segments.push(cur.join(" ")); }

    const stroke = "var(--vscode-charts-blue, #3794ff)";
    const lines = segments.map((s) =>
        `<polyline fill="none" stroke="${stroke}" stroke-width="1.5" points="${s}" stroke-linejoin="round" stroke-linecap="round" />`,
    ).join("");

    // Mark the latest point.
    const lastIdx = values.length - 1;
    const lastV = values[lastIdx];
    const lastDot = Number.isFinite(lastV)
        ? `<circle cx="${(PAD + lastIdx * xStep).toFixed(1)}" cy="${yFor(lastV).toFixed(1)}" r="2" fill="${stroke}" />`
        : "";

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" role="img" aria-label="sparkline">
      ${band}${lines}${lastDot}
    </svg>`;
}

// ---- Detail table ----------------------------------------------------------

function renderTable(entries: HistoryEntry[]): string {
    // Show newest first — most users care about the latest regressions.
    const rows = entries.slice().reverse();
    const resNames = Array.from(new Set(entries.flatMap((e) => e.resources.map((r) => r.name))));
    const prevByIdx = new Map<number, HistoryEntry | undefined>();
    for (let i = 0; i < rows.length; i++) {
        // "previous" in chronological order = the entry that was logged
        // just before this one, which is the *next* row in our reversed view.
        prevByIdx.set(i, rows[i + 1]);
    }

    const headerCells = [
        "<th>When</th>",
        "<th>Commit</th>",
        "<th>Subject</th>",
        ...resNames.map((n) => `<th class="num">${escapeHtml(n)}</th>`),
        `<th class="num">WNS (ns)</th>`,
        `<th class="num">Fmax (MHz)</th>`,
    ].join("");

    const body = rows.map((e, i) => {
        const prev = prevByIdx.get(i);
        const tds: string[] = [];
        tds.push(`<td>${escapeHtml(formatTime(e.timestamp))}</td>`);
        const commitCell = e.commit
            ? `<span title="${escapeAttr(e.commit_subject ?? "")}">${escapeHtml(e.commit)}</span>${e.dirty ? `<span class="dirty-tag" title="Working tree had uncommitted changes at build time">dirty</span>` : ""}`
            : `<span class="sub">—</span>`;
        tds.push(`<td class="commit">${commitCell}</td>`);
        tds.push(`<td class="subject" title="${escapeAttr(e.commit_subject ?? "")}">${escapeHtml(e.commit_subject ?? "")}</td>`);
        for (const name of resNames) {
            const cur = e.resources.find((r) => r.name === name);
            const old = prev?.resources.find((r) => r.name === name);
            tds.push(`<td class="num">${formatResource(cur, old)}</td>`);
        }
        tds.push(`<td class="num">${formatScalar(e.worst_wns_ns, prev?.worst_wns_ns, { decimals: 3, risingIsBad: false })}</td>`);
        tds.push(`<td class="num">${formatScalar(e.best_fmax_mhz, prev?.best_fmax_mhz, { decimals: 1, risingIsBad: false })}</td>`);
        return `<tr>${tds.join("")}</tr>`;
    }).join("");

    return `<table><thead><tr>${headerCells}</tr></thead><tbody>${body}</tbody></table>`;
}

function formatResource(cur?: { used: number; percent: number }, old?: { used: number; percent: number }): string {
    if (!cur) { return `<span class="sub">—</span>`; }
    const base = `${cur.percent.toFixed(1)}%`;
    if (!old) { return base; }
    const delta = cur.used - old.used;
    if (delta === 0) { return `${base}`; }
    const cls = delta > 0 ? "bad" : "ok";
    const sign = delta > 0 ? "+" : "−";
    return `${base}<span class="delta ${cls}">${sign}${Math.abs(delta)}</span>`;
}

function formatScalar(
    cur: number | undefined,
    old: number | undefined,
    opts: { decimals: number; risingIsBad: boolean },
): string {
    if (cur == null || !Number.isFinite(cur)) { return `<span class="sub">—</span>`; }
    const base = cur.toFixed(opts.decimals);
    if (old == null || !Number.isFinite(old)) { return base; }
    const delta = cur - old;
    if (Math.abs(delta) < Math.pow(10, -opts.decimals)) { return base; }
    const isBad = (delta > 0) === opts.risingIsBad;
    const cls = isBad ? "bad" : "ok";
    const sign = delta > 0 ? "+" : "−";
    return `${base}<span class="delta ${cls}">${sign}${Math.abs(delta).toFixed(opts.decimals)}</span>`;
}

function formatTime(ms: number): string {
    return new Date(ms).toLocaleString();
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
