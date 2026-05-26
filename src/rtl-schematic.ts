/**
 * rtl-schematic.ts
 * ----------------------------------------------------------------------------
 * "Schematic" feature: synthesize the project's HDL sources with Yosys and
 * render the resulting netlist as a pannable/zoomable SVG inside a webview.
 * This is the open-source answer to Vivado's RTL/Synthesis viewer.
 *
 * Pipeline:
 *   bitstream.json sources  →  yosys (read + hierarchy + proc + opt + show)
 *                           →  build/rtl_schematic.dot + .svg (via graphviz)
 *                           →  inline SVG in a VS Code webview
 *
 * Yosys's `show` command invokes graphviz `dot` to lay out the netlist, so
 * both binaries must be on PATH (or the paths configured in
 * `hdlToolchain.yosysPath`).
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { readManifest } from "./manifest";

const BUILD_DIR = "build";
const PREFIX = "rtl_schematic";

export class RtlSchematic {
    public static readonly viewType = "bitstream.rtlSchematic";
    private static instance: RtlSchematic | undefined;
    private static output: vscode.OutputChannel | undefined;

    public static async show(workspaceRoot: string): Promise<void> {
        const panel = RtlSchematic.instance?.panel ?? vscode.window.createWebviewPanel(
            RtlSchematic.viewType,
            "RTL Schematic",
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        if (!RtlSchematic.instance) {
            RtlSchematic.instance = new RtlSchematic(panel);
        }
        panel.reveal(vscode.ViewColumn.Active);
        await RtlSchematic.instance.regenerate(workspaceRoot);
    }

    static getOutput(): vscode.OutputChannel {
        if (!RtlSchematic.output) {
            RtlSchematic.output = vscode.window.createOutputChannel("Bitstream: Yosys");
        }
        return RtlSchematic.output;
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private currentRoot: string | undefined;

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === "refresh" && this.currentRoot) {
                void this.regenerate(this.currentRoot);
            }
        }, null, this.disposables);
    }

    private async regenerate(workspaceRoot: string): Promise<void> {
        this.currentRoot = workspaceRoot;
        this.panel.webview.html = renderLoadingHtml();
        try {
            const svg = await runYosys(workspaceRoot);
            this.panel.webview.html = renderSchematicHtml(svg);
        } catch (err: any) {
            this.panel.webview.html = renderErrorHtml(err?.message ?? String(err));
        }
    }

    public dispose(): void {
        RtlSchematic.instance = undefined;
        for (const d of this.disposables) { d.dispose(); }
    }
}

// ---------------------------------------------------------------------------
// Yosys runner
// ---------------------------------------------------------------------------

async function runYosys(workspaceRoot: string): Promise<string> {
    const manifest = readManifest(workspaceRoot);

    // Filter to Verilog / SystemVerilog — yosys reads VHDL only with the
    // out-of-tree GHDL plugin, which we don't assume is available.
    const verilogSrcs = manifest.source_files.filter((f) => /\.(v|sv|vh|svh)$/i.test(f));
    if (!verilogSrcs.length) {
        throw new Error(
            "No Verilog/SystemVerilog sources found in bitstream.json. " +
            "RTL schematic requires .v or .sv files (VHDL is not supported by stock Yosys).",
        );
    }

    const buildDir = path.join(workspaceRoot, BUILD_DIR);
    if (!fs.existsSync(buildDir)) { fs.mkdirSync(buildDir, { recursive: true }); }

    const prefix = path.join(buildDir, PREFIX);
    // Clean previous artefacts so a failing run doesn't display stale output.
    for (const ext of [".dot", ".svg"]) {
        try { fs.unlinkSync(prefix + ext); } catch { /* ignore */ }
    }

    // Yosys script: read all sources, elaborate hierarchy, run a light
    // pre-mapping pass (`proc; opt_clean`) so the schematic shows actual
    // structural logic instead of unprocessed RTL syntax trees, then emit
    // a graphviz SVG via the `show` pass. `-stretch` makes single-driver
    // wires longer so labels don't overlap.
    //
    // We write the script to a file (`-s build/rtl_schematic.ys`) rather
    // than passing it inline via `-p`. Yosys's per-pass argument parsers
    // are inconsistent about stripping quotes — `read_verilog` strips
    // them but `hierarchy -top` keeps them literally — so the safest
    // approach is to emit unquoted tokens and rely on filesystem paths
    // not containing whitespace (the typical case for HDL projects).
    const topLine = manifest.top_module
        ? `hierarchy -check -top ${manifest.top_module}`
        : `hierarchy -check -auto-top`;
    const readLines = verilogSrcs.map((f) => {
        const isSV = /\.(sv|svh)$/i.test(f);
        const flag = isSV ? "-sv " : "";
        return `read_verilog ${flag}${f}`;
    });

    const scriptLines = [
        ...readLines,
        topLine,
        `proc`,
        `opt_clean`,
        `show -format svg -prefix ${path.relative(workspaceRoot, prefix)} -stretch`,
    ];
    const scriptPath = prefix + ".ys";
    fs.writeFileSync(scriptPath, scriptLines.join("\n") + "\n", "utf8");

    const yosysBin = vscode.workspace.getConfiguration().get<string>("hdlToolchain.yosysPath", "yosys") || "yosys";
    const scriptRel = path.relative(workspaceRoot, scriptPath);

    const output = RtlSchematic.getOutput();
    output.appendLine(`\n=== Yosys RTL schematic for ${manifest.project_name} ===`);
    output.appendLine(`# script: ${scriptRel}`);
    for (const line of scriptLines) { output.appendLine(`    ${line}`); }
    output.appendLine(`$ ${yosysBin} -s ${scriptRel}`);
    output.appendLine(`  (cwd: ${workspaceRoot})`);

    await spawnCollect(yosysBin, ["-s", scriptRel], workspaceRoot, output);

    const svgPath = prefix + ".svg";
    if (!fs.existsSync(svgPath)) {
        throw new Error(
            `Yosys completed but produced no SVG at ${svgPath}. ` +
            `Make sure graphviz "dot" is installed and on PATH — yosys "show" shells out to it.`,
        );
    }
    return fs.readFileSync(svgPath, "utf8");
}

function spawnCollect(
    command: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let proc: cp.ChildProcessWithoutNullStreams;
        try {
            proc = cp.spawn(command, args, { cwd, shell: false });
        } catch (err: any) {
            reject(new Error(`Failed to spawn ${command}: ${err.message ?? err}`));
            return;
        }
        proc.stdout.on("data", (d) => output.append(d.toString()));
        proc.stderr.on("data", (d) => output.append(d.toString()));
        proc.on("error", (err) => reject(new Error(
            `Failed to run "${command}": ${err.message}. ` +
            `Install yosys (https://yosyshq.net/yosys/) or set hdlToolchain.yosysPath.`,
        )));
        proc.on("close", (code) => {
            if (code === 0) { resolve(); }
            else { reject(new Error(`yosys exited with code ${code}. See "Bitstream: Yosys" output for details.`)); }
        });
    });
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function renderLoadingHtml(): string {
    return baseHtml(`
      <div class="status">
        <div class="spinner"></div>
        <div>Running Yosys… this can take a few seconds for large designs.</div>
      </div>
    `);
}

function renderErrorHtml(message: string): string {
    return baseHtml(`
      <div class="error">
        <h2>Schematic generation failed</h2>
        <pre>${escapeHtml(message)}</pre>
        <button id="retry">Retry</button>
      </div>
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('retry').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      </script>
    `);
}

function renderSchematicHtml(rawSvg: string): string {
    // Strip only the XML/DOCTYPE preamble — the HTML parser handles the rest.
    // We deliberately do NOT regex-mangle the <svg> tag itself; instead we
    // grab the parsed element from the DOM in JS, which is robust against any
    // whitespace / attribute-order quirks Yosys+graphviz might produce.
    const svg = rawSvg
        .replace(/<\?xml[^?]*\?>/g, "")
        .replace(/<!DOCTYPE[^>]*>/g, "");

    return baseHtml(`
      <div id="toolbar">
        <button id="zoomIn" title="Zoom in">+</button>
        <button id="zoomOut" title="Zoom out">−</button>
        <button id="zoomFit" title="Fit to view">Fit</button>
        <button id="zoomReset" title="100%">1:1</button>
        <span id="zoomLabel">100%</span>
        <span class="sep"></span>
        <button id="refresh" title="Re-run Yosys">Refresh</button>
      </div>
      <div id="viewport"><div id="svgContainer">${svg}</div></div>
      <script>
        const vscode = acquireVsCodeApi();
        const viewport = document.getElementById('viewport');
        const zoomLabel = document.getElementById('zoomLabel');
        const svgEl = document.querySelector('#svgContainer svg');
        if (!svgEl) {
          document.body.innerHTML = '<div class="error"><h2>Empty SVG</h2><pre>Yosys produced no parseable SVG content.</pre></div>';
          throw new Error('no svg');
        }
        svgEl.id = 'schematic';
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        // Pin the SVG element to its viewBox dimensions so it has a fixed
        // intrinsic pixel size and aspect ratio. CSS transforms then scale
        // it directly — at zoom > 1 it overflows the viewport and the
        // viewport's overflow:hidden clips the bits off-screen.
        const baseVB = svgEl.viewBox.baseVal;
        const W = (baseVB && baseVB.width)  || 800;
        const H = (baseVB && baseVB.height) || 600;
        svgEl.setAttribute('width', W);
        svgEl.setAttribute('height', H);
        svgEl.style.width  = W + 'px';
        svgEl.style.height = H + 'px';

        function isDarkTheme() {
          const bg = getComputedStyle(document.body).backgroundColor || '';
          const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
          if (!m) return false;
          const r = +m[1], g = +m[2], b = +m[3];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          return lum < 0.5;
        }
        if (isDarkTheme()) {
          svgEl.classList.add('invert-for-dark');
        }

        // Pan/zoom state in screen-space: the SVG is W×H CSS pixels, drawn
        // at translate(tx,ty) scale(s) inside the viewport. Overflow:hidden
        // on the viewport naturally clips off-screen pieces when zoomed in.
        let s = 1, tx = 0, ty = 0;
        let panning = null;
        const MIN_S = 0.02, MAX_S = 200;

        function apply() {
          svgEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
          zoomLabel.textContent = Math.round(s * 100) + '%';
        }

        function zoomAt(factor, screenX, screenY) {
          const r = viewport.getBoundingClientRect();
          const px = screenX - r.left;
          const py = screenY - r.top;
          const next = Math.max(MIN_S, Math.min(MAX_S, s * factor));
          // Hold the world point under the cursor fixed: pre/post-zoom screen
          // coords match when tx,ty are reprojected through the new scale.
          tx = px - (px - tx) * (next / s);
          ty = py - (py - ty) * (next / s);
          s = next;
          apply();
        }

        /** Fit — scale so the whole SVG fits the viewport with a margin, centered. */
        function fit() {
          const r = viewport.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const pad = 24;
          const sx = (r.width  - pad * 2) / W;
          const sy = (r.height - pad * 2) / H;
          s  = Math.max(MIN_S, Math.min(MAX_S, Math.min(sx, sy)));
          tx = (r.width  - W * s) / 2;
          ty = (r.height - H * s) / 2;
          apply();
        }

        /** 1:1 — one SVG pixel per screen pixel, centered. */
        function oneToOne() {
          const r = viewport.getBoundingClientRect();
          s = 1;
          tx = (r.width  - W) / 2;
          ty = (r.height - H) / 2;
          apply();
        }

        document.getElementById('zoomIn').addEventListener('click', () => {
          const r = viewport.getBoundingClientRect();
          zoomAt(1.25, r.left + r.width / 2, r.top + r.height / 2);
        });
        document.getElementById('zoomOut').addEventListener('click', () => {
          const r = viewport.getBoundingClientRect();
          zoomAt(1 / 1.25, r.left + r.width / 2, r.top + r.height / 2);
        });
        document.getElementById('zoomFit').addEventListener('click', fit);
        document.getElementById('zoomReset').addEventListener('click', oneToOne);
        document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

        viewport.addEventListener('wheel', (ev) => {
          ev.preventDefault();
          const factor = Math.exp(-ev.deltaY * 0.0015);
          zoomAt(factor, ev.clientX, ev.clientY);
        }, { passive: false });

        viewport.addEventListener('mousedown', (ev) => {
          if (ev.button !== 0 && ev.button !== 1) return;
          panning = { x: ev.clientX, y: ev.clientY, tx, ty };
          viewport.classList.add('panning');
        });
        window.addEventListener('mousemove', (ev) => {
          if (!panning) return;
          tx = panning.tx + (ev.clientX - panning.x);
          ty = panning.ty + (ev.clientY - panning.y);
          apply();
        });
        window.addEventListener('mouseup', () => {
          panning = null;
          viewport.classList.remove('panning');
        });

        // Initial layout: fit once the viewport has its final size.
        requestAnimationFrame(() => requestAnimationFrame(fit));
      </script>
    `);
}

function baseHtml(body: string): string {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
  #toolbar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    background: var(--vscode-editorWidget-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    height: 32px; box-sizing: border-box;
  }
  #toolbar button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-panel-border, #444);
    padding: 2px 10px; cursor: pointer; border-radius: 3px;
    font-family: inherit; font-size: 12px;
  }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #toolbar .sep { width: 1px; height: 18px; background: var(--vscode-panel-border, #444); margin: 0 4px; }
  #zoomLabel { font-size: 11px; opacity: 0.7; min-width: 42px; text-align: right; }
  #viewport {
    position: absolute; top: 32px; left: 0; right: 0; bottom: 0;
    overflow: hidden; cursor: grab;
    background: var(--vscode-editor-background);
  }
  #viewport.panning { cursor: grabbing; }
  #schematic {
    position: absolute; top: 0; left: 0;
    transform-origin: 0 0;
    user-select: none; display: block;
    will-change: transform;
  }
  /* Yosys SVG is hard-coded black-on-white. Invert it on dark themes so the
     strokes/text become light-on-dark; the hue-rotate keeps any colored
     wires (yosys uses red/blue for clk/reset) roughly correct after invert. */
  #schematic.invert-for-dark {
    filter: invert(0.92) hue-rotate(180deg);
  }
  .status, .error {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 24px; gap: 16px;
  }
  .error pre {
    max-width: 80ch; max-height: 50vh; overflow: auto;
    background: var(--vscode-textBlockQuote-background, #1e1e1e);
    border: 1px solid var(--vscode-panel-border, #333);
    padding: 12px; border-radius: 4px; text-align: left;
    white-space: pre-wrap; word-break: break-word;
  }
  .error button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, white);
    border: none; padding: 6px 16px; cursor: pointer; border-radius: 3px;
  }
  .spinner {
    width: 28px; height: 28px;
    border: 3px solid var(--vscode-panel-border, #444);
    border-top-color: var(--vscode-progressBar-background, #0e639c);
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
