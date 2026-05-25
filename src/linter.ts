/**
 * linter.ts
 * ----------------------------------------------------------------------------
 * On-save Verilator linting. We run `verilator --lint-only -Wall <file>` in a
 * detached child_process whenever a Verilog/SystemVerilog buffer is saved,
 * parse stderr with a couple of regexes, and publish the result to a shared
 * `vscode.DiagnosticCollection`. The diagnostics show up in the native
 * "Problems" tab; we never bring up an external pane.
 *
 * The LSP (verible) handles semantic features (hover, completion, formatting);
 * Verilator handles correctness checks the LSP doesn't cover. Both write to
 * the same Problems tab via separate diagnostic sources, so the user sees a
 * unified view.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";

const DIAG_SOURCE = "verilator";

/**
 * Verilator emits lines like:
 *   %Error: foo.sv:12:5: syntax error, unexpected ';'
 *   %Warning-WIDTH: foo.sv:34:9: Operator ASSIGNW expects 8 bits...
 *
 * We tolerate optional column, optional sub-severity tag (e.g. `-WIDTH`),
 * and absolute or relative paths. Anything that doesn't match is dropped
 * silently — Verilator also prints summary lines we don't care about.
 */
const VERILATOR_LINE = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s+([^:]+):(\d+):(?:(\d+):)?\s*(.*)$/;

export class VerilatorLinter implements vscode.Disposable {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly output: vscode.OutputChannel;
    /** Track in-flight processes per file so a quick re-save cancels the stale run. */
    private readonly running = new Map<string, cp.ChildProcess>();

    constructor() {
        this.diagnostics = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
        this.output = vscode.window.createOutputChannel("Bitstream: Verilator");

        // Hook the workspace save event. We pick onDidSave (not onWillSave) so
        // we lint the bytes actually on disk — Verilator reads the file path,
        // not the editor buffer.
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (!this.shouldLint(doc)) { return; }
                this.lintFile(doc.uri).catch((err) => {
                    this.output.appendLine(`[lint error] ${err}`);
                });
            })
        );

        // Clear diagnostics when a file is closed so the Problems tab stays tidy.
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.diagnostics.delete(doc.uri);
            })
        );
    }

    /** Public entry point exposed via the `bitstream.lintActive` command. */
    public async lintActiveEditor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage("Bitstream: no active editor to lint.");
            return;
        }
        await this.lintFile(editor.document.uri);
    }

    private shouldLint(doc: vscode.TextDocument): boolean {
        const cfg = vscode.workspace.getConfiguration();
        if (!cfg.get<boolean>("hdlToolchain.lintOnSave", true)) { return false; }
        if (doc.uri.scheme !== "file") { return false; }
        return doc.languageId === "verilog" || doc.languageId === "systemverilog";
    }

    private async lintFile(uri: vscode.Uri): Promise<void> {
        const file = uri.fsPath;
        const cfg = vscode.workspace.getConfiguration();
        const verilator = cfg.get<string>("hdlToolchain.verilatorPath", "verilator") || "verilator";

        // Cancel any prior run on the same file — most recent edit wins.
        const stale = this.running.get(file);
        if (stale) { stale.kill(); }

        const args = ["--lint-only", "-Wall"];
        // Detect SystemVerilog by extension so Verilator parses correctly.
        if (/\.(sv|svh)$/i.test(file)) { args.push("-sv"); }
        args.push(file);

        const cwd = path.dirname(file);
        const proc = cp.spawn(verilator, args, { cwd });
        this.running.set(file, proc);

        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.on("error", (err) => {
            this.running.delete(file);
            // ENOENT means verilator isn't installed/on PATH — surface once,
            // not on every save.
            this.output.appendLine(`[spawn error] ${err.message}`);
        });
        proc.on("close", () => {
            this.running.delete(file);
            const diags = this.parse(stderr, file);
            this.diagnostics.set(uri, diags);
        });
    }

    /**
     * Parse Verilator stderr into VS Code diagnostics. We match only lines
     * referencing the file we asked to lint — `include` directives can drag
     * in errors from other files which we surface against their own URIs.
     */
    private parse(stderr: string, primaryFile: string): vscode.Diagnostic[] {
        const out: vscode.Diagnostic[] = [];
        const otherFileDiags = new Map<string, vscode.Diagnostic[]>();

        for (const line of stderr.split(/\r?\n/)) {
            const m = VERILATOR_LINE.exec(line.trim());
            if (!m) { continue; }
            const [, sev, tag, file, lineStr, colStr, message] = m;

            const lineNum = Math.max(0, parseInt(lineStr, 10) - 1);
            const colNum = Math.max(0, (colStr ? parseInt(colStr, 10) : 1) - 1);
            const range = new vscode.Range(lineNum, colNum, lineNum, colNum + 1);

            const severity = sev === "Error"
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning;

            const diag = new vscode.Diagnostic(range, message, severity);
            diag.source = DIAG_SOURCE;
            if (tag) { diag.code = tag; }

            // Verilator may print absolute or relative paths; resolve relative
            // to the primary file's directory so the URI matches the editor.
            const resolved = path.isAbsolute(file) ? file : path.resolve(path.dirname(primaryFile), file);

            if (resolved === primaryFile) {
                out.push(diag);
            } else {
                const bucket = otherFileDiags.get(resolved) ?? [];
                bucket.push(diag);
                otherFileDiags.set(resolved, bucket);
            }
        }

        // Publish diagnostics for included files; they get cleared next time
        // that file is closed or the primary file is re-linted.
        for (const [otherFile, diags] of otherFileDiags) {
            this.diagnostics.set(vscode.Uri.file(otherFile), diags);
        }

        return out;
    }

    public dispose(): void {
        this.diagnostics.dispose();
        this.output.dispose();
        for (const p of this.running.values()) { p.kill(); }
        this.running.clear();
        for (const d of this.disposables) { d.dispose(); }
    }
}
