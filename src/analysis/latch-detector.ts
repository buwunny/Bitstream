/**
 * latch-detector.ts
 * ----------------------------------------------------------------------------
 * Scrapes synthesis warnings about inferred latches and undriven /
 * partially-driven signals, then reports them in the Problems tab anchored
 * at the offending RTL line.
 *
 * Latches are almost always a mistake (missing else branch, missing case
 * arm) and Verilator's lint-only pass can't catch all of them — they only
 * show up at synthesis. Surfacing the vendor's warning at the source line
 * means the user fixes them before opening the report.
 *
 * Sources we parse:
 *   • Vivado: `vivado.log` in the workspace root (the build command runs
 *     vivado from there, so the log lands there).
 *   • Quartus: `quartus_project/output_files/<project>.map.rpt` and
 *     `<project>.flow.rpt`.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
    manifestExists,
    readManifest,
} from "../project/manifest";

const DIAGNOSTIC_SOURCE = "bitstream-synth";

interface Finding {
    file: string;     // workspace-relative or absolute
    line: number;     // 1-based as reported by the tool
    severity: vscode.DiagnosticSeverity;
    code: string;
    message: string;
}

export class LatchDetector implements vscode.Disposable {
    private readonly diagnostics: vscode.DiagnosticCollection;

    constructor() {
        this.diagnostics = vscode.languages.createDiagnosticCollection("bitstream-synth");
    }

    /**
     * Re-scan vendor logs and refresh diagnostics. No-op when there's no
     * manifest or no log file yet — pre-build state should not surface
     * stale findings.
     */
    public refresh(workspaceRoot: string): void {
        this.diagnostics.clear();
        if (!manifestExists(workspaceRoot)) { return; }
        const manifest = readManifest(workspaceRoot);

        const findings: Finding[] = [];
        if (manifest.vendor === "xilinx") {
            findings.push(...scanVivadoLog(workspaceRoot));
        } else {
            findings.push(...scanQuartusReports(workspaceRoot, manifest.project_name));
        }

        // Group by absolute file path so we issue one set() per file.
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const f of findings) {
            const abs = path.isAbsolute(f.file) ? f.file : path.join(workspaceRoot, f.file);
            // Synth output is 1-based; clamp negatives to 0 just in case.
            const row = Math.max(0, f.line - 1);
            const range = new vscode.Range(row, 0, row, Number.MAX_SAFE_INTEGER);
            const d = new vscode.Diagnostic(range, f.message, f.severity);
            d.source = DIAGNOSTIC_SOURCE;
            d.code = f.code;
            const arr = byFile.get(abs) ?? [];
            arr.push(d);
            byFile.set(abs, arr);
        }
        for (const [file, diags] of byFile) {
            this.diagnostics.set(vscode.Uri.file(file), diags);
        }
    }

    public dispose(): void {
        this.diagnostics.dispose();
    }
}

// ---------------------------------------------------------------------------
// Vivado
// ---------------------------------------------------------------------------

/**
 * Vivado writes the main build log into the directory it was invoked from
 * (workspace root for us). Older versions also leave a `vivado_<n>.log`
 * suffixed file behind — we prefer the unsuffixed one and fall back to the
 * most recent suffixed log.
 */
function scanVivadoLog(workspaceRoot: string): Finding[] {
    const logPath = pickVivadoLog(workspaceRoot);
    if (!logPath) { return []; }
    let txt: string;
    try { txt = fs.readFileSync(logPath, "utf8"); } catch { return []; }
    return parseVivadoFindings(txt);
}

function pickVivadoLog(workspaceRoot: string): string | undefined {
    const primary = path.join(workspaceRoot, "vivado.log");
    if (fs.existsSync(primary)) { return primary; }
    try {
        const entries = fs.readdirSync(workspaceRoot)
            .filter((n) => /^vivado.*\.log$/i.test(n))
            .map((n) => path.join(workspaceRoot, n));
        if (!entries.length) { return undefined; }
        entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return entries[0];
    } catch { return undefined; }
}

/**
 * Match Vivado synth messages of the form:
 *
 *   WARNING: [Synth 8-327] inferring latch for variable 'foo_reg' [/abs/file.v:42]
 *   INFO:    [Synth 8-3332] Sequential element (...) is unused and will be removed
 *
 * The file:line annotation is the trailing `[path:line]`. We're conservative
 * about which message codes we keep — only latch inference, undriven nets,
 * incomplete sensitivity lists.
 */
function parseVivadoFindings(txt: string): Finding[] {
    const out: Finding[] = [];
    const lines = txt.split(/\r?\n/);

    const locRe = /\[([^\[\]]+):(\d+)\]\s*$/;
    const isWarn = /^\s*(WARNING|CRITICAL WARNING):/i;
    const isInfo = /^\s*INFO:/i;

    const rules: Array<{ pattern: RegExp; code: string; severity: vscode.DiagnosticSeverity }> = [
        { pattern: /\[Synth 8-327\]\b/, code: "inferred-latch", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\binferring latch\b/i, code: "inferred-latch", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\[Synth 8-614\]\b/, code: "undriven", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\bsignal\b.*\bnever assigned\b/i, code: "undriven", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\bpartially driven\b/i, code: "partial-drive", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\bincomplete sensitivity list\b/i, code: "sensitivity-list", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\bmulti-driven\b/i, code: "multi-driven", severity: vscode.DiagnosticSeverity.Warning },
    ];

    for (const ln of lines) {
        if (!isWarn.test(ln) && !isInfo.test(ln)) { continue; }
        const rule = rules.find((r) => r.pattern.test(ln));
        if (!rule) { continue; }
        const loc = locRe.exec(ln);
        if (!loc) { continue; }
        const file = loc[1];
        const lineNum = parseInt(loc[2], 10);
        if (!Number.isFinite(lineNum) || lineNum <= 0) { continue; }
        out.push({
            file,
            line: lineNum,
            severity: rule.severity,
            code: rule.code,
            message: stripVivadoNoise(ln),
        });
    }
    return out;
}

function stripVivadoNoise(line: string): string {
    // Drop the trailing "[file:line]" and leading severity word.
    return line
        .replace(/\s*\[[^\[\]]+:\d+\]\s*$/, "")
        .replace(/^\s*(?:WARNING|CRITICAL WARNING|INFO):\s*/i, "")
        .trim();
}

// ---------------------------------------------------------------------------
// Quartus
// ---------------------------------------------------------------------------

/**
 * Quartus splits messages across `.map.rpt` (analysis & synthesis) and
 * `.flow.rpt`. Latch inferences appear in the map report.
 *
 * The wire format we match:
 *
 *   Warning (10240): Verilog HDL Always Construct warning at top.v(15):
 *                    inferring latch(es) for variable "x"
 *
 * Some messages wrap onto a second line; we accept either layout.
 */
function scanQuartusReports(workspaceRoot: string, projectName: string): Finding[] {
    const candidates = [
        path.join(workspaceRoot, "quartus_project", "output_files", `${projectName}.map.rpt`),
        path.join(workspaceRoot, "quartus_project", "output_files", `${projectName}.flow.rpt`),
        path.join(workspaceRoot, "quartus_project", "output_files", `${projectName}.syn.rpt`),
    ];
    const out: Finding[] = [];
    for (const p of candidates) {
        if (!fs.existsSync(p)) { continue; }
        try {
            const txt = fs.readFileSync(p, "utf8");
            out.push(...parseQuartusFindings(txt));
        } catch { /* ignore */ }
    }
    return out;
}

function parseQuartusFindings(txt: string): Finding[] {
    const out: Finding[] = [];
    // Collapse soft-wrapped warning bodies into single lines first.
    const collapsed = txt.replace(/\n\s{8,}/g, " ");
    const lines = collapsed.split(/\r?\n/);

    const rules: Array<{ pattern: RegExp; code: string; severity: vscode.DiagnosticSeverity }> = [
        { pattern: /inferring latch(?:\(es\))? for/i, code: "inferred-latch", severity: vscode.DiagnosticSeverity.Warning },
        { pattern: /\bnever assigned\b|\bnever used\b/i, code: "undriven", severity: vscode.DiagnosticSeverity.Information },
        { pattern: /\btruncated\b/i, code: "truncation", severity: vscode.DiagnosticSeverity.Information },
        { pattern: /\bsensitivity list\b/i, code: "sensitivity-list", severity: vscode.DiagnosticSeverity.Warning },
    ];

    // `Warning (NNNNN): ... at file.ext(line):` — file in group 1, line in 2.
    const locRe = /\bat\s+([^\s()]+)\s*\((\d+)\)/i;

    for (const ln of lines) {
        if (!/^(Warning|Error|Info)\b/.test(ln)) { continue; }
        const rule = rules.find((r) => r.pattern.test(ln));
        if (!rule) { continue; }
        const loc = locRe.exec(ln);
        if (!loc) { continue; }
        const file = loc[1];
        const lineNum = parseInt(loc[2], 10);
        if (!Number.isFinite(lineNum) || lineNum <= 0) { continue; }
        out.push({
            file,
            line: lineNum,
            severity: rule.severity,
            code: rule.code,
            message: ln.replace(/^[A-Za-z]+\s*\(\d+\):\s*/, "").trim(),
        });
    }
    return out;
}
