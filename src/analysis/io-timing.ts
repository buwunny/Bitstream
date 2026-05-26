/**
 * io-timing.ts
 * ----------------------------------------------------------------------------
 * Pin / IO timing report. Cross-references three sources to surface
 * IO-related problems in the Problems tab:
 *
 *   • Top-module port list (parsed from RTL via hierarchy.ts).
 *   • Pin map (from `bitstream.json#pin_map`).
 *   • The per-path timing report we already scrape for the Critical Path
 *     Inspector — we pull out the paths whose source or destination is an
 *     IO port (input setup, or clock-to-out).
 *
 * Diagnostics are anchored at the port's declaration line in the top
 * module source file, with a "Pin Planner" code action so the user can
 * jump straight to the editor that fixes the issue.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
    BitstreamManifest,
    manifestExists,
    readManifest,
} from "../project/manifest";
import { ModuleDecl, ModulePort, parseWorkspaceModules } from "../project/hierarchy";
import { TimingPath, loadCriticalPaths } from "./critical-paths";

const DIAGNOSTIC_SOURCE = "bitstream-io";

interface PortLocation {
    file: string;    // workspace-relative
    line: number;    // zero-based
    column: number;  // zero-based
    length: number;
}

export class IoTimingChecker implements vscode.Disposable {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly actions: vscode.Disposable;

    constructor() {
        this.diagnostics = vscode.languages.createDiagnosticCollection("bitstream-io");
        this.actions = vscode.languages.registerCodeActionsProvider(
            [
                { scheme: "file", language: "verilog" },
                { scheme: "file", language: "systemverilog" },
            ],
            new IoCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
        );
    }

    /**
     * Re-scan the workspace and refresh diagnostics. Cheap and idempotent:
     * called after every build, on activation, and on manual invocation.
     */
    public refresh(workspaceRoot: string): void {
        this.diagnostics.clear();
        if (!manifestExists(workspaceRoot)) { return; }
        const manifest = readManifest(workspaceRoot);
        if (!manifest.top_module) { return; }

        const decls = parseWorkspaceModules(workspaceRoot, manifest.source_files);
        const top = decls.find((d) => d.name === manifest.top_module);
        if (!top) { return; }

        const portNames = new Set(top.ports.map((p) => p.name));
        const paths = loadCriticalPaths(workspaceRoot, manifest.vendor, manifest.project_name)?.paths ?? [];

        // Bucket diagnostics by file so we make one set() call per file.
        const byFile = new Map<string, vscode.Diagnostic[]>();
        const pushDiag = (loc: PortLocation, d: vscode.Diagnostic) => {
            const abs = path.isAbsolute(loc.file) ? loc.file : path.join(workspaceRoot, loc.file);
            const arr = byFile.get(abs) ?? [];
            arr.push(d);
            byFile.set(abs, arr);
        };

        // 1) Ports without a pin assignment → Information.
        const pinMap = manifest.pin_map ?? {};
        for (const port of top.ports) {
            if (pinMap[port.name]) { continue; }
            const loc = locatePortInTop(workspaceRoot, top, port);
            if (!loc) { continue; }
            const range = new vscode.Range(loc.line, loc.column, loc.line, loc.column + loc.length);
            const d = new vscode.Diagnostic(
                range,
                `Port "${port.name}" (${port.direction}) has no pin assignment. Open the Pin Planner to map it.`,
                vscode.DiagnosticSeverity.Information,
            );
            d.source = DIAGNOSTIC_SOURCE;
            d.code = "io-unassigned";
            pushDiag(loc, d);
        }

        // 2) IO timing violations → Warning/Error per path.
        for (const tp of paths) {
            if (!Number.isFinite(tp.slack_ns) || tp.slack_ns >= 0) { continue; }
            const sourcePort = matchPort(tp.source, portNames);
            const destPort = matchPort(tp.destination, portNames);
            // Skip pure register-to-register paths — those belong to the
            // critical-path inspector, not the IO report.
            if (!sourcePort && !destPort) { continue; }

            const ioPortName = destPort ?? sourcePort!;
            const port = top.ports.find((p) => p.name === ioPortName);
            if (!port) { continue; }
            const loc = locatePortInTop(workspaceRoot, top, port);
            if (!loc) { continue; }

            const kind = destPort
                ? "Clock-to-out"
                : "Input setup";
            const slackStr = `${tp.slack_ns.toFixed(3)} ns`;
            const clock = tp.dest_clock ?? tp.source_clock ?? "unknown";
            const range = new vscode.Range(loc.line, loc.column, loc.line, loc.column + loc.length);
            const d = new vscode.Diagnostic(
                range,
                `${kind} violation on "${ioPortName}" (${slackStr} slack, clock ${clock}).`,
                vscode.DiagnosticSeverity.Warning,
            );
            d.source = DIAGNOSTIC_SOURCE;
            d.code = destPort ? "io-clock-to-out" : "io-input-setup";
            pushDiag(loc, d);
        }

        for (const [file, diags] of byFile) {
            this.diagnostics.set(vscode.Uri.file(file), diags);
        }
    }

    public dispose(): void {
        this.diagnostics.dispose();
        this.actions.dispose();
    }
}

/**
 * Test whether a Vivado/Quartus resource string refers to a top-level IO
 * port. We tokenise on "/" and "|", then for each token strip common pad
 * buffer suffixes (`_IBUF`, `_OBUF`, `_BUFG`, `_inst`) and the bracketed
 * bit-select, and check the result against the port-name set.
 */
function matchPort(resource: string | undefined, portNames: Set<string>): string | undefined {
    if (!resource) { return undefined; }
    const tokens = resource.split(/[\/|]/).filter(Boolean);
    for (const tok of tokens) {
        const bare = tok
            .replace(/\[[^\]]*\]$/, "")
            .replace(/_inst$/, "")
            .replace(/_(IBUF|OBUF|IBUFG|OBUFT|BUFG|IBUF_inst|OBUF_inst)$/, "");
        if (portNames.has(bare)) { return bare; }
    }
    return undefined;
}

/**
 * Find the declaration of `port` in the top module source file. Returns
 * undefined if we can't open the file or pinpoint the name. We prefer the
 * first occurrence where the port name appears alongside its direction
 * keyword; that's the ANSI declaration in the module header.
 */
function locatePortInTop(workspaceRoot: string, top: ModuleDecl, port: ModulePort): PortLocation | undefined {
    const abs = path.isAbsolute(top.file) ? top.file : path.join(workspaceRoot, top.file);
    let txt: string;
    try { txt = fs.readFileSync(abs, "utf8"); } catch { return undefined; }
    const lines = txt.split(/\r?\n/);
    const word = new RegExp(`\\b${escapeRegex(port.name)}\\b`);
    const decl = new RegExp(`\\b(?:input|output|inout)\\b[^;]*\\b${escapeRegex(port.name)}\\b`);
    let row = -1;
    for (let i = 0; i < lines.length; i++) {
        if (decl.test(lines[i])) { row = i; break; }
    }
    if (row < 0) {
        for (let i = 0; i < lines.length; i++) {
            if (word.test(lines[i])) { row = i; break; }
        }
    }
    if (row < 0) { return undefined; }
    const col = lines[row].search(word);
    return { file: top.file, line: row, column: Math.max(col, 0), length: port.name.length };
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Quick-fix action: any of our IO diagnostics surfaces an "Open Pin
 * Planner" command. We don't try to do the assignment automatically — the
 * Pin Planner is the right place for the user to pick a pin.
 */
class IoCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        _document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        const ours = context.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE);
        if (!ours.length) { return []; }
        const action = new vscode.CodeAction("Open Pin Planner", vscode.CodeActionKind.QuickFix);
        action.command = { command: "bitstream.openPinPlanner", title: "Open Pin Planner" };
        action.diagnostics = ours;
        return [action];
    }
}
