/**
 * reports.ts
 * ----------------------------------------------------------------------------
 * Post-build report scraping. Vivado and Quartus both drop plain-text reports
 * after place/route; this module turns them into a vendor-neutral
 * `BuildReport` so the dashboard UI can render either flow without knowing
 * which tool produced the numbers.
 *
 * What we extract:
 *   • Utilization: LUT / FF / BRAM / DSP — used, available, percent
 *   • Timing summary: WNS / TNS slack (setup, hold), Fmax for the worst clock
 *   • Source: which .rpt file(s) the numbers came from, with mtime
 *
 * Parsing is regex-based and intentionally forgiving. Vendor report formats
 * shift slightly across tool versions, so we anchor on stable column headers
 * and skip rows we don't recognise rather than crashing the whole parse.
 */

import * as fs from "fs";
import * as path from "path";
import { Vendor } from "../project/manifest";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ResourceMetric {
    name: string;            // "LUT", "FF", "BRAM", "DSP"
    used: number;
    available: number;       // 0 when the report didn't disclose a denominator
    percent: number;         // 0..100
}

export interface ClockMetric {
    name: string;
    period_ns?: number;      // requested period if known
    wns_ns?: number;         // setup slack worst negative
    tns_ns?: number;         // setup total negative
    whs_ns?: number;         // hold worst negative
    ths_ns?: number;         // hold total negative
    fmax_mhz?: number;       // Quartus restricted Fmax, or computed from WNS+period
}

export interface BuildReport {
    vendor: Vendor;
    project_name: string;
    device?: string;
    generated_at?: number;   // ms epoch — most recent mtime across source files
    resources: ResourceMetric[];
    clocks: ClockMetric[];
    sources: string[];       // absolute paths of files we parsed
    warnings: string[];      // soft parse issues, surfaced in the UI footer
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Locate and parse the most recent reports for the given workspace. Returns
 * `null` if no recognisable reports exist yet (build hasn't run, or it
 * failed before the reporting stages).
 */
export function loadBuildReport(
    workspaceRoot: string,
    vendor: Vendor,
    projectName: string,
): BuildReport | null {
    if (vendor === "xilinx") {
        return loadVivadoReport(workspaceRoot, projectName);
    }
    return loadQuartusReport(workspaceRoot, projectName);
}

// ---------------------------------------------------------------------------
// Vivado
// ---------------------------------------------------------------------------

/**
 * Vivado's `report_utilization` and `report_timing_summary` both write plain
 * text. We standardise on `build/<project>_utilization.rpt` and
 * `build/<project>_timing.rpt` because that's what the generated build Tcl
 * is wired to emit (see toolchain.ts).
 */
function loadVivadoReport(workspaceRoot: string, projectName: string): BuildReport | null {
    const buildDir = path.join(workspaceRoot, "build");
    const utilPath = path.join(buildDir, `${projectName}_utilization.rpt`);
    const timingPath = path.join(buildDir, `${projectName}_timing.rpt`);

    const sources: string[] = [];
    const warnings: string[] = [];
    const resources: ResourceMetric[] = [];
    const clocks: ClockMetric[] = [];

    if (fs.existsSync(utilPath)) {
        sources.push(utilPath);
        try {
            const txt = fs.readFileSync(utilPath, "utf8");
            resources.push(...parseVivadoUtilization(txt));
        } catch (e: any) {
            warnings.push(`Failed to parse utilization report: ${e.message ?? e}`);
        }
    }

    if (fs.existsSync(timingPath)) {
        sources.push(timingPath);
        try {
            const txt = fs.readFileSync(timingPath, "utf8");
            clocks.push(...parseVivadoTiming(txt));
        } catch (e: any) {
            warnings.push(`Failed to parse timing report: ${e.message ?? e}`);
        }
    }

    if (!sources.length) { return null; }
    return {
        vendor: "xilinx",
        project_name: projectName,
        resources,
        clocks,
        sources,
        warnings,
        generated_at: latestMtime(sources),
    };
}

/**
 * Vivado utilization report layout (post-2018-ish):
 *
 *   +------------------------+------+-------+------------+-----------+-------+
 *   |        Site Type       | Used | Fixed | Prohibited | Available | Util% |
 *   +------------------------+------+-------+------------+-----------+-------+
 *   | Slice LUTs             |  124 |     0 |          0 |     63400 |  0.20 |
 *   |   LUT as Logic         |  124 |     0 |          0 |     63400 |  0.20 |
 *   ...
 *
 * We match on a small whitelist of row names (one per resource category) and
 * pull the first three numeric columns: used, _, _, available, percent.
 */
function parseVivadoUtilization(txt: string): ResourceMetric[] {
    const wanted: Array<{ key: string; rowName: RegExp }> = [
        { key: "LUT", rowName: /^Slice LUTs\s*\**\s*$/ },
        { key: "FF", rowName: /^(Slice Registers|Register as Flip Flop)\s*$/ },
        { key: "BRAM", rowName: /^Block RAM Tile\s*$/ },
        { key: "DSP", rowName: /^DSPs\s*$/ },
    ];

    const out = new Map<string, ResourceMetric>();
    const lines = txt.split(/\r?\n/);
    for (const line of lines) {
        // Table rows start with "|" and use "|" as separators.
        if (!line.startsWith("|")) { continue; }
        const cells = line.split("|").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
        if (cells.length < 5) { continue; }
        const name = cells[0];
        for (const w of wanted) {
            if (out.has(w.key)) { continue; }
            if (!w.rowName.test(name)) { continue; }
            const used = numOrNaN(cells[1]);
            // Last two columns are Available, Util%.
            const available = numOrNaN(cells[cells.length - 2]);
            const percent = numOrNaN(cells[cells.length - 1]);
            if (Number.isFinite(used) && Number.isFinite(available)) {
                out.set(w.key, {
                    name: w.key,
                    used,
                    available,
                    percent: Number.isFinite(percent) ? percent : (available > 0 ? (used / available) * 100 : 0),
                });
            }
            break;
        }
    }
    return Array.from(out.values());
}

/**
 * Vivado timing summary, the bit we care about:
 *
 *   ------------------------------------------------------------------------------------------------
 *   | Design Timing Summary
 *   | ---------------------
 *   ...
 *       WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)
 *       -------      -------  ---------------------  -------------------      -------      -------
 *         1.234      0.000                       0                  100        0.456        0.000
 *
 * Plus optional per-clock blocks further down. We extract the design-wide row
 * for the overall slack and synthesise a single "design" clock entry. If a
 * per-clock summary block follows, we add those too.
 */
function parseVivadoTiming(txt: string): ClockMetric[] {
    const clocks: ClockMetric[] = [];

    // Design-wide row.
    const designHeader = /WNS\(ns\)\s+TNS\(ns\).+WHS\(ns\)\s+THS\(ns\)/;
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!designHeader.test(lines[i])) { continue; }
        // Skip the dashed separator row.
        const dataLine = lines[i + 2] ?? "";
        const nums = dataLine.trim().split(/\s+/).map(numOrNaN);
        if (nums.length >= 6 && Number.isFinite(nums[0])) {
            clocks.push({
                name: "Design (all clocks)",
                wns_ns: nums[0],
                tns_ns: nums[1],
                whs_ns: nums[4],
                ths_ns: nums[5],
            });
        }
        break;
    }

    // Per-clock summary table. Header looks like:
    //   Clock           WNS(ns)  TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints
    const clockHeader = /^Clock\s+WNS\(ns\)/;
    for (let i = 0; i < lines.length; i++) {
        if (!clockHeader.test(lines[i].trim())) { continue; }
        // Walk forward over the dashed separator and consume data rows until
        // we hit a blank line.
        let j = i + 2;
        while (j < lines.length && lines[j].trim()) {
            const parts = lines[j].trim().split(/\s+/);
            // Clock name may itself be multi-word, but Vivado pads with whitespace
            // — the trailing numerics are reliable so we work right-to-left.
            const wns = numOrNaN(parts[parts.length - 4]);
            const tns = numOrNaN(parts[parts.length - 3]);
            if (Number.isFinite(wns)) {
                const name = parts.slice(0, parts.length - 4).join(" ") || "unnamed";
                clocks.push({ name, wns_ns: wns, tns_ns: Number.isFinite(tns) ? tns : undefined });
            }
            j++;
        }
        break;
    }

    return clocks;
}

// ---------------------------------------------------------------------------
// Quartus
// ---------------------------------------------------------------------------

/**
 * Quartus emits multiple .rpt files under `quartus_project/output_files/`:
 *   <project>.fit.summary      — terse top-level used/available block
 *   <project>.fit.rpt          — same numbers plus the detailed body
 *   <project>.sta.summary      — Slack / TNS / restricted Fmax per clock
 *   <project>.sta.rpt          — full timing analyser output
 *
 * The .summary files are stable across Quartus versions and dramatically
 * easier to parse than the full .rpt bodies, so we prefer them.
 */
function loadQuartusReport(workspaceRoot: string, projectName: string): BuildReport | null {
    const outDir = path.join(workspaceRoot, "quartus_project", "output_files");
    const fitSummary = path.join(outDir, `${projectName}.fit.summary`);
    const fitRpt = path.join(outDir, `${projectName}.fit.rpt`);
    const staSummary = path.join(outDir, `${projectName}.sta.summary`);

    const sources: string[] = [];
    const warnings: string[] = [];
    const resources: ResourceMetric[] = [];
    const clocks: ClockMetric[] = [];
    let device: string | undefined;

    const fitFile = fs.existsSync(fitSummary) ? fitSummary : (fs.existsSync(fitRpt) ? fitRpt : undefined);
    if (fitFile) {
        sources.push(fitFile);
        try {
            const txt = fs.readFileSync(fitFile, "utf8");
            const parsed = parseQuartusFit(txt);
            resources.push(...parsed.resources);
            device = parsed.device;
        } catch (e: any) {
            warnings.push(`Failed to parse fit summary: ${e.message ?? e}`);
        }
    }

    if (fs.existsSync(staSummary)) {
        sources.push(staSummary);
        try {
            const txt = fs.readFileSync(staSummary, "utf8");
            clocks.push(...parseQuartusStaSummary(txt));
        } catch (e: any) {
            warnings.push(`Failed to parse STA summary: ${e.message ?? e}`);
        }
    }

    if (!sources.length) { return null; }
    return {
        vendor: "intel",
        project_name: projectName,
        device,
        resources,
        clocks,
        sources,
        warnings,
        generated_at: latestMtime(sources),
    };
}

/**
 * Quartus fit summary excerpt:
 *
 *   Family : Cyclone V
 *   Device : 5CSEMA5F31C6
 *   Logic utilization (in ALMs) : 1,234 / 32,070 ( 4 % )
 *   Total registers : 5678
 *   Total block memory bits : 12,345 / 4,065,280 ( < 1 % )
 *   Total DSP Blocks : 4 / 87 ( 5 % )
 *
 * Numbers may include commas; percent column is sometimes "< 1 %". We're
 * permissive about both.
 */
function parseQuartusFit(txt: string): { resources: ResourceMetric[]; device?: string } {
    const lines = txt.split(/\r?\n/);
    const resources: ResourceMetric[] = [];
    let device: string | undefined;

    // "<key> : <number>[ / <available> ( <pct>% )]"
    const re = /^(.+?)\s*:\s*([\d,]+)(?:\s*\/\s*([\d,]+))?(?:\s*\(\s*([<>=]?\s*[\d.]+)\s*%\s*\))?\s*$/;
    const wanted: Array<{ key: string; matches: (label: string) => boolean }> = [
        { key: "LUT", matches: (l) => /Logic utilization/i.test(l) || /Total logic elements/i.test(l) },
        { key: "FF", matches: (l) => /Total registers/i.test(l) },
        { key: "BRAM", matches: (l) => /block memory bits/i.test(l) || /Total memory bits/i.test(l) || /M9K|M10K|M20K/i.test(l) },
        { key: "DSP", matches: (l) => /DSP\s*Blocks/i.test(l) || /Embedded Multiplier/i.test(l) },
    ];

    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith("Device") && line.includes(":")) {
            device = line.split(":")[1].trim();
            continue;
        }
        const m = re.exec(line);
        if (!m) { continue; }
        const label = m[1].trim();
        for (const w of wanted) {
            if (resources.some((r) => r.name === w.key)) { continue; }
            if (!w.matches(label)) { continue; }
            const used = parseNumberWithCommas(m[2]);
            const available = m[3] ? parseNumberWithCommas(m[3]) : 0;
            const percent = m[4]
                ? parseFloat(m[4].replace(/[<>=\s]/g, ""))
                : (available > 0 ? (used / available) * 100 : 0);
            resources.push({ name: w.key, used, available, percent });
            break;
        }
    }
    return { resources, device };
}

/**
 * Quartus STA summary blocks look like:
 *
 *   ; Slow 1100mV 85C Model Setup Summary                                          ;
 *   ; Clock        ; Slack    ; End Point TNS ;
 *   ; clk          ; 0.123    ; 0.000         ;
 *
 *   ; Slow 1100mV 85C Model Fmax Summary                                           ;
 *   ; Fmax        ; Restricted Fmax ; Clock Name ; Note ;
 *   ; 123.45 MHz  ; 100.00 MHz      ; clk        ;      ;
 *
 * We merge by clock name across the Setup, Hold, and Fmax blocks.
 */
function parseQuartusStaSummary(txt: string): ClockMetric[] {
    const lines = txt.split(/\r?\n/);
    const byName = new Map<string, ClockMetric>();
    const get = (name: string): ClockMetric => {
        if (!byName.has(name)) { byName.set(name, { name }); }
        return byName.get(name)!;
    };

    type Mode = "none" | "setup" | "hold" | "fmax";
    let mode: Mode = "none";

    for (const raw of lines) {
        const line = raw.trim();
        if (/Setup Summary/i.test(line)) { mode = "setup"; continue; }
        if (/Hold Summary/i.test(line)) { mode = "hold"; continue; }
        if (/Fmax Summary/i.test(line)) { mode = "fmax"; continue; }
        if (!line.startsWith(";")) { mode = "none"; continue; }

        // Header rows we want to skip.
        if (/Clock/i.test(line) && /Slack/i.test(line)) { continue; }
        if (/^;\s*Fmax/i.test(line) && /Restricted Fmax/i.test(line)) { continue; }

        const cells = line.split(";").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
        if (!cells.length) { continue; }

        if (mode === "setup" && cells.length >= 3) {
            const name = cells[0];
            if (!name || /^[-]+$/.test(name)) { continue; }
            const slack = numOrNaN(cells[1]);
            const tns = numOrNaN(cells[2]);
            if (!Number.isFinite(slack)) { continue; }
            const c = get(name);
            c.wns_ns = slack;
            if (Number.isFinite(tns)) { c.tns_ns = tns; }
        } else if (mode === "hold" && cells.length >= 3) {
            const name = cells[0];
            if (!name || /^[-]+$/.test(name)) { continue; }
            const slack = numOrNaN(cells[1]);
            const tns = numOrNaN(cells[2]);
            if (!Number.isFinite(slack)) { continue; }
            const c = get(name);
            c.whs_ns = slack;
            if (Number.isFinite(tns)) { c.ths_ns = tns; }
        } else if (mode === "fmax" && cells.length >= 3) {
            // ; Fmax ; Restricted Fmax ; Clock Name ; Note ;
            const fmax = parseFmaxMhz(cells[0]);
            const restricted = parseFmaxMhz(cells[1]);
            const name = cells[2];
            if (!name) { continue; }
            const c = get(name);
            // Restricted Fmax is the achievable number Quartus signs off on —
            // the unrestricted figure ignores hold/recovery and is misleading.
            c.fmax_mhz = Number.isFinite(restricted) ? restricted : (Number.isFinite(fmax) ? fmax : undefined);
        }
    }

    return Array.from(byName.values());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numOrNaN(s: string | undefined): number {
    if (!s) { return NaN; }
    // Strip non-numeric tail (e.g. "ns", "%", "MHz") and commas.
    const cleaned = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return cleaned ? parseFloat(cleaned[0]) : NaN;
}

function parseNumberWithCommas(s: string): number {
    return parseFloat(s.replace(/,/g, ""));
}

function parseFmaxMhz(s: string): number {
    // "123.45 MHz" or "123.45"
    const n = numOrNaN(s);
    return n;
}

function latestMtime(paths: string[]): number | undefined {
    let max = 0;
    for (const p of paths) {
        try {
            const mt = fs.statSync(p).mtimeMs;
            if (mt > max) { max = mt; }
        } catch { /* ignore */ }
    }
    return max || undefined;
}
