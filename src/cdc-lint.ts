/**
 * cdc-lint.ts
 * ----------------------------------------------------------------------------
 * Lightweight clock-domain-crossing lint. We walk every `always @(posedge
 * clk)` / `always_ff @(posedge clk)` block in the manifest's source files,
 * map each flop output to its clock domain, and flag any flop whose RHS
 * reads a signal driven by a *different* clock — unless we can detect a
 * 2+ stage synchroniser chain in the destination domain.
 *
 * This is a heuristic, not a SpyGlass replacement. False positives happen
 * (gated clocks aliased through wires, async-FIFO-shaped patterns we don't
 * recognise). False negatives also happen (combinational logic between two
 * clock domains, or crossings that hide behind a generate-loop instance).
 * Both modes degrade gracefully: a missed crossing is a missed warning,
 * and an extra warning is a one-line `// cdc-lint: ignore` away.
 *
 * The diagnostics are surfaced through a dedicated `vscode.DiagnosticCollection`
 * so they live alongside Verilator output without clobbering it.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface AlwaysBlock {
    /** Clock name as it appears after `posedge`/`negedge`. */
    clock: string;
    /** Offset into the file where `begin` (or the lone statement) starts. */
    bodyStart: number;
    /** Text of the block body (excluding the outer begin/end keywords). */
    body: string;
}

interface FlopAssign {
    file: string;            // workspace-relative
    line: number;            // 1-based
    column: number;          // 0-based
    endColumn: number;
    /** Bare LHS name with index/concat stripped. */
    lhs: string;
    /** Identifiers read anywhere in the statement (incl. `if (...)` conditions). */
    reads: string[];
    /** True if RHS is exactly one identifier — used for synchroniser detection. */
    rhsIsSingleSignal: boolean;
    /** The single RHS identifier when `rhsIsSingleSignal`. */
    rhsSingleSignal?: string;
    /** Domain the assignment fires in. */
    clock: string;
    /** Raw source line, used in the diagnostic body. */
    snippet: string;
    /** If the line has `// cdc-lint: ignore`, we skip emitting for it. */
    suppressed: boolean;
}

// Verilog/SV reserved words and common type names — never treated as signals
// when extracting reads from RHS. Kept narrow on purpose; identifiers we miss
// just become extra (typically harmless) tracked names.
const RESERVED = new Set([
    "begin", "end", "if", "else", "case", "casez", "casex", "endcase",
    "default", "for", "while", "do", "forever", "repeat", "return", "break",
    "continue", "posedge", "negedge", "or", "and", "not", "xor", "xnor",
    "nand", "nor", "wire", "reg", "logic", "bit", "byte", "integer", "real",
    "time", "string", "input", "output", "inout", "signed", "unsigned",
    "automatic", "static", "packed", "struct", "union", "enum", "typedef",
    "parameter", "localparam", "assign", "always", "always_ff", "always_comb",
    "always_latch", "initial", "function", "endfunction", "task", "endtask",
    "module", "endmodule", "generate", "endgenerate", "genvar",
    "fork", "join", "join_any", "join_none", "wait", "this", "super",
    "null", "void", "new", "extends", "virtual", "pure",
]);

// Common synchroniser-flop name hints. Matching one of these isn't required —
// the chain-of-flops check is the load-bearing signal — but having a hinted
// name removes the warning even when the chain detector can't follow the
// dataflow (e.g. crossing through a hand-rolled gray-coded FIFO).
const SYNC_NAME_HINT = /(?:^|_)(sync|synced|sync\d*|meta|metastable|cdc|ff\d|s\d|sync_ff|cross)(?:$|_)/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CdcFinding {
    file: string;
    line: number;       // 1-based
    column: number;
    endColumn: number;
    signal: string;
    sourceClock: string;
    destClock: string;
    /** Either "single-flop" (no chain detected) or "direct" (signal used in logic). */
    kind: "single-flop" | "logic";
    snippet: string;
}

/**
 * Scan the workspace's source files and return every CDC violation we can
 * spot. The caller turns these into `vscode.Diagnostic` and pushes them
 * into a collection (see `runCdcLint`).
 */
export function analyseWorkspace(workspaceRoot: string, sourceFiles: string[]): CdcFinding[] {
    const assigns: FlopAssign[] = [];
    for (const rel of sourceFiles) {
        if (!/\.(v|sv|vh|svh)$/i.test(rel)) { continue; }
        const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
        let raw: string;
        try { raw = fs.readFileSync(abs, "utf8"); } catch { continue; }
        for (const a of analyseFile(raw, rel)) { assigns.push(a); }
    }
    return findCrossings(assigns);
}

// ---------------------------------------------------------------------------
// Per-file parsing
// ---------------------------------------------------------------------------

function analyseFile(raw: string, relPath: string): FlopAssign[] {
    const text = stripComments(raw);
    const lineIndex = buildLineIndex(raw);
    const out: FlopAssign[] = [];
    for (const block of findAlwaysBlocks(text)) {
        const stmts = splitStatements(block.body, block.bodyStart);
        for (const stmt of stmts) {
            const assign = parseAssignment(stmt.text, stmt.offset, block.clock, raw, lineIndex, relPath);
            if (assign) { out.push(assign); }
        }
    }
    return out;
}

/**
 * Replace block and line comments with spaces of equal length. Preserving
 * lengths keeps every offset/line lookup we do downstream pointing at the
 * original character in `raw`.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function buildLineIndex(raw: string): number[] {
    const out = [0];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === "\n") { out.push(i + 1); }
    }
    return out;
}

function lineColOf(idx: number[], offset: number): { line: number; col: number } {
    let lo = 0, hi = idx.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (idx[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
    }
    return { line: lo + 1, col: offset - idx[lo] };
}

// ---------------------------------------------------------------------------
// always-block discovery
// ---------------------------------------------------------------------------

function findAlwaysBlocks(text: string): AlwaysBlock[] {
    const out: AlwaysBlock[] = [];
    // `always @(posedge clk)` or `always_ff @(posedge clk or negedge rst)`.
    // We only key off the first posedge/negedge identifier and treat that
    // as the block's clock domain. Async resets are intentionally ignored —
    // they're a different clock, but in practice every same-clock block
    // declares the same reset, so they'd never alias.
    const re = /\balways(?:_ff)?\s*@\s*\(\s*(?:posedge|negedge)\s+([A-Za-z_]\w*)[^)]*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const clock = m[1];
        let i = re.lastIndex;
        while (i < text.length && /\s/.test(text[i])) { i++; }
        if (matchWordAt(text, i, "begin")) {
            const end = findMatchingEnd(text, i);
            if (end < 0) { continue; }
            out.push({ clock, bodyStart: i + 5, body: text.slice(i + 5, end) });
        } else {
            // Single-statement form: `always @(posedge clk) x <= y;`.
            const semi = text.indexOf(";", i);
            if (semi === -1) { continue; }
            out.push({ clock, bodyStart: i, body: text.slice(i, semi + 1) });
        }
    }
    return out;
}

function matchWordAt(text: string, i: number, word: string): boolean {
    if (text.substr(i, word.length) !== word) { return false; }
    const after = text[i + word.length];
    return !after || /[^A-Za-z0-9_]/.test(after);
}

/**
 * Walk forward from `i` (which points at `begin`) and return the offset
 * just past the matching `end`. Counts nested begin/end / case/endcase /
 * fork/join so the body of nested constructs doesn't terminate the block
 * early. Returns -1 if unbalanced (treated as parse failure).
 */
function findMatchingEnd(text: string, i: number): number {
    let depth = 0;
    let j = i;
    while (j < text.length) {
        const ch = text[j];
        // Skip string literals so a "; end" inside a string doesn't fool us.
        if (ch === '"') {
            j++;
            while (j < text.length && text[j] !== '"') { if (text[j] === "\\") { j++; } j++; }
            j++; continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            // Read identifier
            let k = j;
            while (k < text.length && /[A-Za-z0-9_]/.test(text[k])) { k++; }
            const word = text.slice(j, k);
            if (word === "begin" || word === "fork" || word === "case" || word === "casez" || word === "casex") {
                depth++;
            } else if (word === "end" || word === "join" || word === "join_any" || word === "join_none" || word === "endcase") {
                depth--;
                if (depth === 0) { return j; }
            }
            j = k;
            continue;
        }
        j++;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Statement splitting + assignment parsing
// ---------------------------------------------------------------------------

interface Statement {
    text: string;
    /** Offset into the original raw source where this statement starts. */
    offset: number;
}

/**
 * Split a block body into statements on `;` at brace/bracket/paren depth 0.
 * Begin/end blocks introduced by `if`/`case`/etc. inside the body are
 * treated transparently — we still split on their inner semicolons. That
 * means an `if (cond) lhs <= rhs;` shows up as two statements (`if (cond)
 * lhs <= rhs` then empty), which is fine because the empty one parses
 * as no-assignment.
 */
function splitStatements(body: string, bodyStart: number): Statement[] {
    const out: Statement[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === "(" || c === "[" || c === "{") { depth++; }
        else if (c === ")" || c === "]" || c === "}") { depth--; }
        else if (c === ";" && depth === 0) {
            out.push({ text: body.slice(start, i), offset: bodyStart + start });
            start = i + 1;
        }
    }
    if (start < body.length) {
        out.push({ text: body.slice(start), offset: bodyStart + start });
    }
    return out;
}

/**
 * Pull `lhs <= rhs` (or `lhs = rhs`) out of a statement. Returns null when
 * the statement is a non-assignment (a bare `if`, a `begin`, etc).
 *
 * The assignment operator is found at depth-0 to avoid matching `==`,
 * `>=`, `<=` used as comparison operators, or `<=` inside subexpressions
 * like `(a <= b) ? c : d`.
 */
function parseAssignment(
    stmt: string,
    offset: number,
    clock: string,
    raw: string,
    lineIndex: number[],
    relPath: string,
): FlopAssign | null {
    const opPos = findAssignmentOp(stmt);
    if (!opPos) { return null; }
    const lhsText = stmt.slice(0, opPos.index);
    const rhsText = stmt.slice(opPos.index + opPos.op.length);

    const lhsName = extractLhsName(lhsText);
    if (!lhsName) { return null; }

    // Read set: every identifier in the statement that isn't the LHS itself
    // or a reserved word / number-literal artefact.
    const reads = collectIdentifiers(stmt).filter((id) => id !== lhsName);

    // Detect "rhs is a single signal" — we use this to spot synchroniser
    // chains where `sync_a <= unsynced` and `sync_b <= sync_a`.
    const rhsCleaned = rhsText.replace(/\(|\)|\s/g, "");
    const singleM = /^([A-Za-z_]\w*)$/.exec(rhsCleaned);
    const rhsSingle = singleM ? singleM[1] : undefined;

    // Locate the LHS in the original source so we can place the diagnostic
    // accurately. The lhs name appears somewhere in stmt; find its offset
    // (search the raw text, not the comment-stripped one, so column lines up).
    const lhsLocalIdx = lhsText.indexOf(lhsName);
    const lhsAbsOffset = offset + (lhsLocalIdx >= 0 ? lhsLocalIdx : 0);
    const { line, col } = lineColOf(lineIndex, lhsAbsOffset);
    const endColumn = col + lhsName.length;

    // Snippet: the matching line from the original source.
    const lineStart = lineIndex[line - 1];
    const lineEnd = lineIndex[line] ?? raw.length;
    const snippet = raw.slice(lineStart, lineEnd).replace(/\r?\n$/, "").trim();

    const suppressed = /\/\/\s*cdc-lint\s*:\s*ignore/i.test(snippet);

    return {
        file: relPath,
        line,
        column: col,
        endColumn,
        lhs: lhsName,
        reads,
        rhsIsSingleSignal: !!rhsSingle,
        rhsSingleSignal: rhsSingle,
        clock,
        snippet,
        suppressed,
    };
}

function findAssignmentOp(stmt: string): { op: "<=" | "="; index: number } | null {
    let depth = 0;
    for (let i = 0; i < stmt.length - 1; i++) {
        const c = stmt[i];
        if (c === "(" || c === "[" || c === "{") { depth++; continue; }
        if (c === ")" || c === "]" || c === "}") { depth--; continue; }
        if (depth !== 0) { continue; }
        if (c === "<" && stmt[i + 1] === "=") { return { op: "<=", index: i }; }
        if (c === "=") {
            const prev = stmt[i - 1] ?? " ";
            const next = stmt[i + 1] ?? " ";
            if (next === "=" || prev === "=" || prev === "<" || prev === ">" || prev === "!") { continue; }
            return { op: "=", index: i };
        }
    }
    return null;
}

/** From a LHS expression like `data_out[3:0]`, return the bare name `data_out`. */
function extractLhsName(lhs: string): string | null {
    const m = /([A-Za-z_]\w*)/.exec(lhs.trim());
    return m ? m[1] : null;
}

/**
 * Pull identifiers out of an arbitrary expression. We skip number literals
 * with sized-radix prefixes (`8'hFF`, `4'b1010`), reserved words, and the
 * obvious operator soup.
 */
function collectIdentifiers(text: string): string[] {
    // Drop sized-literal prefixes so the trailing `hFF`/`b1010` isn't
    // misread as an identifier.
    const cleaned = text.replace(/\b\d+'[bBoOdDhH][0-9a-fA-F_xXzZ]+/g, " ");
    const out = new Set<string>();
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
        if (RESERVED.has(m[0])) { continue; }
        out.add(m[0]);
    }
    return Array.from(out);
}

// ---------------------------------------------------------------------------
// Cross-domain detection
// ---------------------------------------------------------------------------

function findCrossings(assigns: FlopAssign[]): CdcFinding[] {
    // signal → set of clock domains that drive it.
    const writerClocks = new Map<string, Set<string>>();
    for (const a of assigns) {
        let s = writerClocks.get(a.lhs);
        if (!s) { s = new Set(); writerClocks.set(a.lhs, s); }
        s.add(a.clock);
    }

    // Index by destination domain so the synchroniser-chain check is O(1):
    // for `dst <= src` in domain B, is there any `dst2 <= dst` also in B?
    const chainStarts = new Map<string, Set<string>>(); // clock → set of single-signal RHS names
    for (const a of assigns) {
        if (!a.rhsIsSingleSignal || !a.rhsSingleSignal) { continue; }
        let s = chainStarts.get(a.clock);
        if (!s) { s = new Set(); chainStarts.set(a.clock, s); }
        s.add(a.rhsSingleSignal);
    }

    const findings: CdcFinding[] = [];

    for (const a of assigns) {
        if (a.suppressed) { continue; }
        // For each signal this statement reads, check whether it has a
        // writer in some clock domain other than `a.clock`.
        for (const r of a.reads) {
            const domains = writerClocks.get(r);
            if (!domains) { continue; }
            // The signal also being driven by our own clock is fine — that
            // means it's same-domain (this is the common case).
            if (domains.has(a.clock)) { continue; }
            // Otherwise, every domain in `domains` is foreign.
            // We pick the first non-matching one to label the finding.
            const foreign = Array.from(domains).find((d) => d !== a.clock)!;

            // Synchroniser-chain check, only applicable when this statement
            // is `dst <= r` (single signal RHS). We OK the crossing if there
            // exists another flop in our domain whose RHS is *our* LHS —
            // i.e., `a.lhs` is itself fed forward into a second flop.
            const chained = a.rhsIsSingleSignal
                && a.rhsSingleSignal === r
                && chainStarts.get(a.clock)?.has(a.lhs);

            const hinted = a.rhsIsSingleSignal && SYNC_NAME_HINT.test(a.lhs);

            if (chained || hinted) { continue; }

            findings.push({
                file: a.file,
                line: a.line,
                column: a.column,
                endColumn: a.endColumn,
                signal: r,
                sourceClock: foreign,
                destClock: a.clock,
                kind: a.rhsIsSingleSignal ? "single-flop" : "logic",
                snippet: a.snippet,
            });
        }
    }

    return findings;
}

// ---------------------------------------------------------------------------
// VS Code integration
// ---------------------------------------------------------------------------

export class CdcLinter {
    private readonly collection: vscode.DiagnosticCollection;

    constructor() {
        this.collection = vscode.languages.createDiagnosticCollection("bitstream-cdc");
    }

    public dispose(): void {
        this.collection.dispose();
    }

    public clear(): void { this.collection.clear(); }

    /**
     * Run the lint over the workspace and surface diagnostics. Returns
     * the count so the caller can report a quick status to the user.
     */
    public run(workspaceRoot: string, sourceFiles: string[]): number {
        this.collection.clear();
        const findings = analyseWorkspace(workspaceRoot, sourceFiles);

        // Group per file so we can push one diagnostic array per Uri.
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const f of findings) {
            const range = new vscode.Range(
                new vscode.Position(f.line - 1, f.column),
                new vscode.Position(f.line - 1, f.endColumn),
            );
            const msg = f.kind === "single-flop"
                ? `CDC: signal "${f.signal}" (clock "${f.sourceClock}") sampled in clock "${f.destClock}" without a 2-stage synchroniser. Add a sync chain or rename the flop with a "_sync" suffix.`
                : `CDC: signal "${f.signal}" (clock "${f.sourceClock}") used in combinational logic under clock "${f.destClock}". Synchronise it through dedicated flops before consuming.`;
            const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning);
            diag.source = "bitstream-cdc";
            diag.code = f.kind === "single-flop" ? "CDC-001" : "CDC-002";
            const abs = path.join(workspaceRoot, f.file);
            const arr = byFile.get(abs) ?? [];
            arr.push(diag);
            byFile.set(abs, arr);
        }
        for (const [file, diags] of byFile) {
            this.collection.set(vscode.Uri.file(file), diags);
        }
        return findings.length;
    }
}
