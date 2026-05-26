/**
 * critical-paths.ts
 * ----------------------------------------------------------------------------
 * Parses per-path timing reports (Vivado `report_timing`, Quartus
 * `.sta.rpt`) into a vendor-neutral `TimingPath[]`. The Critical Path
 * Inspector view consumes these to show the worst N paths with
 * click-to-jump back to the RTL source line.
 *
 * Parsing is, again, regex-based and forgiving — vendor output drifts
 * across tool versions and corner cases (multi-cycle paths, hold checks
 * intermixed with setup, etc.) are tolerated by skipping anything that
 * doesn't look like a path header.
 *
 * Source mapping is best-effort: a Vivado endpoint like
 * `u_top/u_alu/result_reg[0]/Q` is split into an instance path
 * (`u_top/u_alu`), a register stem (`result`), and a pin (`Q`). The
 * inspector uses the parsed module hierarchy to map the instance path
 * to a source file, then greps that file for the register stem.
 */

import * as fs from "fs";
import * as path from "path";
import { Vendor } from "../project/manifest";

export interface TimingPathPoint {
    /** Hierarchical netlist resource, e.g. `u_top/u_alu/result_reg[0]/Q`. */
    resource: string;
    /** Per-step incremental delay in ns, if reported. */
    incr_ns?: number;
    /** Cumulative path delay in ns at this point, if reported. */
    cum_ns?: number;
    /** Vivado "Delay type" column, e.g. `LUT3 (Prop_lut3_I0_O)` / `net (fo=1, routed)`. */
    delay_type?: string;
    /** Physical site/location (Vivado), e.g. `SLICE_X1Y1`. Empty for nets. */
    location?: string;
}

export interface TimingPath {
    /** Setup slack in ns. Negative ⇒ violated. */
    slack_ns: number;
    source: string;
    destination: string;
    source_clock?: string;
    dest_clock?: string;
    path_group?: string;
    /** "Setup", "Hold", "Recovery", "Removal", etc. */
    path_type?: string;
    requirement_ns?: number;
    data_path_delay_ns?: number;
    logic_levels?: number;
    /** Step-by-step path, in order from source register to destination. */
    points: TimingPathPoint[];
}

export interface CriticalPathsReport {
    vendor: Vendor;
    /** Absolute path of the report file the paths came from. */
    source_file: string;
    /** mtime of the source file in ms-epoch. */
    generated_at?: number;
    paths: TimingPath[];
    /** Soft parse warnings, surfaced as a footer in the view. */
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Locate the per-path report for the workspace. Vivado writes one at the
 * standard path we emit from the build Tcl; Quartus's `.sta.rpt` always
 * contains a "Setup: Worst-Case Path" section we can scrape directly.
 */
export function loadCriticalPaths(
    workspaceRoot: string,
    vendor: Vendor,
    projectName: string,
): CriticalPathsReport | null {
    if (vendor === "xilinx") {
        const p = path.join(workspaceRoot, "build", `${projectName}_timing_paths.rpt`);
        if (!fs.existsSync(p)) { return null; }
        const txt = fs.readFileSync(p, "utf8");
        const warnings: string[] = [];
        const paths = parseVivadoPaths(txt, warnings);
        return { vendor, source_file: p, paths, warnings, generated_at: mtime(p) };
    }
    const p = path.join(workspaceRoot, "quartus_project", "output_files", `${projectName}.sta.rpt`);
    if (!fs.existsSync(p)) { return null; }
    const txt = fs.readFileSync(p, "utf8");
    const warnings: string[] = [];
    const paths = parseQuartusPaths(txt, warnings);
    return { vendor, source_file: p, paths, warnings, generated_at: mtime(p) };
}

function mtime(p: string): number | undefined {
    try { return fs.statSync(p).mtimeMs; } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Vivado per-path parsing
// ---------------------------------------------------------------------------

/**
 * Vivado `report_timing` per-path block. We split the report on the
 * "Slack" header that opens each block and parse each chunk individually
 * — this keeps a malformed block from poisoning siblings.
 */
function parseVivadoPaths(txt: string, warnings: string[]): TimingPath[] {
    const out: TimingPath[] = [];
    // Each path block starts with "Slack (MET|VIOLATED) :" — split there.
    const blocks = txt.split(/(?=^Slack\s+\([A-Z]+\)\s*:)/m);
    for (const block of blocks) {
        if (!/^Slack\s+\(/m.test(block)) { continue; }
        try {
            const p = parseVivadoSingle(block);
            if (p) { out.push(p); }
        } catch (e: any) {
            warnings.push(`Skipped malformed path block: ${e.message ?? e}`);
        }
    }
    return out;
}

function parseVivadoSingle(block: string): TimingPath | null {
    const slackM = /^Slack\s+\([A-Z]+\)\s*:\s*(-?[\d.]+)\s*ns/m.exec(block);
    if (!slackM) { return null; }
    const slack = parseFloat(slackM[1]);

    const sourceM = /^\s*Source:\s+(\S+)/m.exec(block);
    const destM = /^\s*Destination:\s+(\S+)/m.exec(block);
    if (!sourceM || !destM) { return null; }

    // Clock annotations sit on the *next* indented line, in parens.
    const srcClk = afterColon(block, sourceM.index!, /clocked by\s+(\S+)/);
    const dstClk = afterColon(block, destM.index!, /clocked by\s+(\S+)/);

    const pathGroupM = /^\s*Path Group:\s+(\S+)/m.exec(block);
    const pathTypeM = /^\s*Path Type:\s+(.+?)\s*$/m.exec(block);
    const reqM = /^\s*Requirement:\s+(-?[\d.]+)\s*ns/m.exec(block);
    const dpdM = /^\s*Data Path Delay:\s+(-?[\d.]+)\s*ns/m.exec(block);
    const logicM = /^\s*Logic Levels:\s+(\d+)/m.exec(block);

    const points = parseVivadoPoints(block);

    return {
        slack_ns: slack,
        source: sourceM[1],
        destination: destM[1],
        source_clock: srcClk,
        dest_clock: dstClk,
        path_group: pathGroupM?.[1],
        path_type: pathTypeM?.[1],
        requirement_ns: reqM ? parseFloat(reqM[1]) : undefined,
        data_path_delay_ns: dpdM ? parseFloat(dpdM[1]) : undefined,
        logic_levels: logicM ? parseInt(logicM[1], 10) : undefined,
        points,
    };
}

/**
 * The path table sits under a "Location  Delay type  Incr(ns)  Path(ns) ..."
 * header followed by a dashed rule and N rows. Rows end at the first blank
 * line after the rule.
 */
function parseVivadoPoints(block: string): TimingPathPoint[] {
    const lines = block.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && !/^\s*Location\s+Delay type/.test(lines[i])) { i++; }
    if (i >= lines.length) { return []; }
    // Skip header + the dashed separator immediately after it.
    i++;
    if (i < lines.length && /^\s*-{3,}/.test(lines[i])) { i++; }

    const out: TimingPathPoint[] = [];
    for (; i < lines.length; i++) {
        const ln = lines[i];
        if (!ln.trim()) { break; }
        // Rough column slicing: location is fixed-width on the left, then
        // we have delay-type, two floats, and the netlist resource trailing
        // to EOL. Real Vivado output uses padding — match by structure:
        //   <loc?> <delay-type-multi-word> <incr> <cum> [rfu] <resource>
        // The two floats are the anchor. Find them, slice the rest off.
        const m = /(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(?:[rf]\s+)?(\S+)\s*$/.exec(ln);
        if (!m) {
            // Continuation line (long resource paths wrap) — append to last.
            const last = out[out.length - 1];
            if (last) { last.resource = (last.resource + ln.trim()).trim(); }
            continue;
        }
        const incr = parseFloat(m[1]);
        const cum = parseFloat(m[2]);
        const resource = m[3];
        // Everything before the first float is "location + delay-type". The
        // location column is usually a single token like "SLICE_X1Y1" or
        // blank; the rest is the delay-type description.
        const lead = ln.slice(0, m.index).trim();
        const leadTokens = lead.split(/\s+/);
        let location: string | undefined;
        let delayType = lead;
        if (leadTokens.length > 0 && /^[A-Z][A-Z0-9_]*(?:_X\d+Y\d+)?$/.test(leadTokens[0])) {
            location = leadTokens[0];
            delayType = leadTokens.slice(1).join(" ");
        }
        out.push({
            resource,
            incr_ns: incr,
            cum_ns: cum,
            delay_type: delayType || undefined,
            location,
        });
    }
    return out;
}

/** Look for `re` in the lines after `index` until a blank line — returns the captured group. */
function afterColon(block: string, index: number, re: RegExp): string | undefined {
    const tail = block.slice(index);
    const lines = tail.split(/\r?\n/).slice(1, 5);
    for (const ln of lines) {
        if (!ln.trim()) { break; }
        const m = re.exec(ln);
        if (m) { return m[1]; }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Quartus per-path parsing
// ---------------------------------------------------------------------------

/**
 * Quartus `.sta.rpt` contains a "Setup: Worst-Case ... Slack Paths" section
 * per clock per corner. Each path looks roughly like:
 *
 *   +------------------------------------------------------------------+
 *   ; Path #N: Setup slack is -1.234                                   ;
 *   +------------------------------------------------------------------+
 *   ; Path Summary
 *   ; Property            ; Value
 *   ; From Node           ; u_top|u_alu|result[0]
 *   ; To Node             ; u_top|out[0]
 *   ; Launch Clock        ; clk
 *   ; Latch Clock         ; clk
 *   ; Data Arrival Path
 *   ; Total              ; Incr      ; Type   ; Element
 *   ; 0.000              ; 0.000     ; ...    ; clock network ...
 *   ; ...                ; ...       ; ...    ; CELL u_top|u_alu|result[0]
 *
 * We anchor on the "Path #N:" line and parse forward to the next path or
 * the end of the section.
 */
function parseQuartusPaths(txt: string, warnings: string[]): TimingPath[] {
    const out: TimingPath[] = [];
    const re = /^.*Path\s+#\d+:\s+Setup\s+slack\s+is\s+(-?[\d.]+)/gm;
    const headers: Array<{ slack: number; start: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) !== null) {
        headers.push({ slack: parseFloat(m[1]), start: m.index });
    }
    for (let i = 0; i < headers.length; i++) {
        const start = headers[i].start;
        const end = i + 1 < headers.length ? headers[i + 1].start : Math.min(start + 16000, txt.length);
        const block = txt.slice(start, end);
        try {
            const p = parseQuartusSingle(block, headers[i].slack);
            if (p) { out.push(p); }
        } catch (e: any) {
            warnings.push(`Skipped malformed path block: ${e.message ?? e}`);
        }
    }
    return out;
}

function parseQuartusSingle(block: string, slack: number): TimingPath | null {
    const get = (label: string): string | undefined => {
        const re = new RegExp(`;\\s*${label}\\s*;\\s*([^;]+?)\\s*(?:;|$)`, "m");
        const m = re.exec(block);
        return m ? m[1].trim() : undefined;
    };
    const source = get("From Node");
    const destination = get("To Node");
    if (!source || !destination) { return null; }
    const launch = get("Launch Clock");
    const latch = get("Latch Clock");
    const dataDelay = get("Data Delay");

    const points: TimingPathPoint[] = [];
    // Data Arrival Path table rows: ; Total ; Incr ; Type ; Element ;
    const lines = block.split(/\r?\n/);
    let inArrival = false;
    for (const ln of lines) {
        if (/Data Arrival Path/.test(ln)) { inArrival = true; continue; }
        if (/Data Required Path/.test(ln)) { inArrival = false; }
        if (!inArrival) { continue; }
        if (!ln.startsWith(";")) { continue; }
        if (/Property|Total\s+;\s+Incr/.test(ln)) { continue; }
        const cells = ln.split(";").map((c) => c.trim());
        // Expect [empty, total, incr, type, element, empty]
        if (cells.length < 5) { continue; }
        const total = parseFloat(cells[1]);
        const incr = parseFloat(cells[2]);
        const type = cells[3];
        const element = cells.slice(4).join(" ").trim();
        if (!Number.isFinite(total) || !element) { continue; }
        points.push({
            resource: element,
            cum_ns: total,
            incr_ns: Number.isFinite(incr) ? incr : undefined,
            delay_type: type || undefined,
        });
    }

    return {
        slack_ns: slack,
        source,
        destination,
        source_clock: launch,
        dest_clock: latch,
        path_type: "Setup",
        data_path_delay_ns: dataDelay ? parseFloat(dataDelay) : undefined,
        points,
    };
}

// ---------------------------------------------------------------------------
// Source mapping — endpoint name → (file, line)
// ---------------------------------------------------------------------------

export interface SourceLocation {
    file: string;       // workspace-relative
    line: number;       // 1-based
    snippet: string;    // the matched line, trimmed
}

/**
 * Best-effort jump: take a hierarchical netlist endpoint
 * (`u_top/u_alu/result_reg[0]/Q` or Quartus's pipe form `u_top|u_alu|result[0]`)
 * and try to find the RTL declaration in the workspace.
 *
 * Strategy:
 *   1. Normalise separators to "/" so both vendors look the same.
 *   2. Strip any trailing pin (single uppercase letter after a "/", or
 *      simple cell-pin words like Q/D/CK/CE).
 *   3. The last segment is the leaf signal; everything before is the
 *      instance path. Strip the `_reg` suffix Vivado appends to registers.
 *   4. Grep the source files for `\bsignal\b` and return the first match.
 *      If the instance path narrows the search to a known module, prefer
 *      its source file.
 */
export function resolveEndpoint(
    workspaceRoot: string,
    endpoint: string,
    sourceFiles: string[],
    instanceFileMap?: Map<string, string>,
): SourceLocation | undefined {
    const norm = endpoint.replace(/\|/g, "/");
    const parts = norm.split("/").filter(Boolean);
    if (!parts.length) { return undefined; }

    // Drop a trailing pin like "Q", "D", "CK", "CE", "R", "S", "C".
    const pinLike = /^[A-Z]{1,3}\d*$/;
    let leaf = parts[parts.length - 1];
    if (pinLike.test(leaf) && parts.length > 1) {
        parts.pop();
        leaf = parts[parts.length - 1];
    }

    // Strip the `_reg` suffix Vivado appends to flop names.
    let signal = leaf.replace(/\[[^\]]*\]$/, "").replace(/_reg$/, "");
    // Also tolerate the Vivado bus-bit suffix `_reg[0]_0` rename.
    signal = signal.replace(/_\d+$/, "");
    if (!signal) { return undefined; }

    const instPath = parts.slice(0, -1);

    // Preferred file: the deepest instance in the path that we recognise.
    const preferred: string[] = [];
    if (instanceFileMap) {
        for (let i = instPath.length - 1; i >= 0; i--) {
            const inst = instPath[i].replace(/\[[^\]]*\]$/, "");
            const file = instanceFileMap.get(inst);
            if (file && !preferred.includes(file)) { preferred.push(file); }
        }
    }

    const candidates = [...preferred, ...sourceFiles.filter((f) => !preferred.includes(f))];
    const word = new RegExp(`\\b${escapeRegex(signal)}\\b`);
    for (const rel of candidates) {
        const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
        let txt: string;
        try { txt = fs.readFileSync(abs, "utf8"); } catch { continue; }
        const lines = txt.split(/\r?\n/);
        // Prefer a declaration line if one exists.
        const declRe = new RegExp(`\\b(?:reg|wire|logic|input|output|inout)\\b[^;]*\\b${escapeRegex(signal)}\\b`);
        for (let i = 0; i < lines.length; i++) {
            if (declRe.test(lines[i])) {
                return { file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 200) };
            }
        }
        for (let i = 0; i < lines.length; i++) {
            if (word.test(lines[i])) {
                return { file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 200) };
            }
        }
    }
    return undefined;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
