/**
 * hierarchy.ts
 * ----------------------------------------------------------------------------
 * Lightweight Verilog/SystemVerilog parser used to build the module
 * hierarchy tree shown in the Project Explorer and to seed the Pin Planner
 * with the top module's port list.
 *
 * This is a regex-based heuristic — not a real Verilog parser. It handles
 * the common cases (ANSI port lists, named instantiations) well enough for
 * the surface features that depend on it and degrades gracefully on syntax
 * it can't read: a missed module just doesn't appear in the tree, never
 * a hard crash.
 */

import * as fs from "fs";
import * as path from "path";

export type PortDirection = "input" | "output" | "inout";

export interface ModulePort {
    name: string;
    direction: PortDirection;
    width: number;
}

export interface ModuleInstance {
    /** Referenced module name (e.g. `adder`). */
    type: string;
    /** Instance identifier (e.g. `u_adder`). */
    name: string;
}

export interface ModuleDecl {
    name: string;
    /** Workspace-relative source path. */
    file: string;
    ports: ModulePort[];
    instances: ModuleInstance[];
}

/**
 * Verilog/SV reserved words we never want to treat as a module type when
 * scanning for instantiations. Not exhaustive — false positives at this
 * stage just mean a phantom child in the tree, which the user spots
 * immediately.
 */
const RESERVED = new Set([
    "module", "endmodule", "begin", "end", "if", "else", "case", "endcase",
    "for", "while", "repeat", "forever", "default", "casez", "casex",
    "input", "output", "inout", "wire", "reg", "logic", "bit", "byte",
    "integer", "real", "time", "string", "parameter", "localparam",
    "assign", "always", "always_ff", "always_comb", "always_latch",
    "initial", "function", "endfunction", "task", "endtask",
    "generate", "endgenerate", "genvar", "typedef", "struct", "union",
    "enum", "packed", "signed", "unsigned", "automatic", "static",
    "interface", "endinterface", "modport", "import", "export", "package",
    "endpackage", "return", "break", "continue", "posedge", "negedge",
    "edge", "or", "and", "not", "xor", "xnor", "nand", "nor", "buf",
    "do", "fork", "join", "join_any", "join_none", "wait",
    "specify", "endspecify", "specparam", "config", "endconfig",
    "design", "instance", "cell", "use", "include", "define", "undef",
    "ifdef", "ifndef", "endif", "elsif", "timescale",
    "supply0", "supply1", "tri", "triand", "trior", "tri0", "tri1", "trireg",
    "this", "super", "null", "void", "new", "extends", "virtual", "pure",
]);

/** Strip `//` and `/* *\/` comments. Keeps line numbers consistent (newlines preserved). */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, "");
}

/**
 * Parse a single port list body (the text between the module's parentheses).
 * Supports ANSI declarations with optional direction, type, width, and
 * comma-separated name lists. Non-ANSI declarations (where directions appear
 * in the body) are ignored — emitting the port list still works because
 * the names appear inside the parens.
 */
function parsePortList(body: string): ModulePort[] {
    if (!body.trim()) { return []; }
    // The list may look like:  input wire clk, input wire [7:0] data, output reg q
    // We split conservatively on commas at brace-depth 0.
    const items: string[] = [];
    let depth = 0, current = "";
    for (const ch of body) {
        if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; continue; }
        if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; continue; }
        if (ch === "," && depth === 0) { items.push(current); current = ""; continue; }
        current += ch;
    }
    if (current.trim()) { items.push(current); }

    const out: ModulePort[] = [];
    let lastDir: PortDirection = "input";
    let lastWidth = 1;
    for (const raw of items) {
        const item = raw.trim();
        if (!item) { continue; }
        // Direction (carries over to subsequent items without one — matches Verilog).
        const dirM = /^(input|output|inout)\b/.exec(item);
        if (dirM) { lastDir = dirM[1] as PortDirection; }
        // Optional bit width [hi:lo].
        const widthM = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(item);
        if (widthM) {
            const hi = parseInt(widthM[1], 10), lo = parseInt(widthM[2], 10);
            lastWidth = Math.abs(hi - lo) + 1;
        }
        // Last identifier on the line is the port name (after stripping types/widths).
        const cleaned = item
            .replace(/\b(input|output|inout|wire|reg|logic|bit|signed|unsigned|var)\b/g, " ")
            .replace(/\[[^\]]*\]/g, " ")
            .replace(/=.*$/, "")
            .trim();
        const nameM = /([A-Za-z_]\w*)\s*$/.exec(cleaned);
        if (!nameM) { continue; }
        out.push({ name: nameM[1], direction: lastDir, width: lastWidth });
    }
    return out;
}

/**
 * Pull every module declaration out of one file. We slice between `module`
 * and `endmodule` keywords so instantiation scanning stays inside the
 * right module body.
 */
export function parseVerilogText(src: string, relPath: string): ModuleDecl[] {
    const text = stripComments(src);
    const out: ModuleDecl[] = [];

    // Match each `module NAME [#(...)] (PORTS); ... endmodule` block.
    // The non-greedy [\s\S]*? to the next `endmodule` keeps blocks separate
    // even when several modules live in one file.
    const re = /\bmodule\s+([A-Za-z_]\w*)\s*(?:#\s*\([\s\S]*?\))?\s*\(([\s\S]*?)\)\s*;([\s\S]*?)\bendmodule\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        const ports = parsePortList(m[2]);
        const body = m[3];

        // Find named instantiations: `type instance ( ... );`. Optional
        // parameter assignment `type #(...) instance (...);` is allowed.
        // We require both identifiers to be non-reserved.
        const instRe = /\b([A-Za-z_]\w*)\s*(?:#\s*\([\s\S]*?\))?\s+([A-Za-z_]\w*)\s*\(/g;
        const instances: ModuleInstance[] = [];
        const seen = new Set<string>();
        let im: RegExpExecArray | null;
        while ((im = instRe.exec(body)) !== null) {
            const type = im[1], inst = im[2];
            if (RESERVED.has(type) || RESERVED.has(inst)) { continue; }
            // De-dup on instance name within a module — repeated regex hits
            // happen if there are parameter blocks.
            if (seen.has(inst)) { continue; }
            seen.add(inst);
            instances.push({ type, name: inst });
        }
        out.push({ name, file: relPath, ports, instances });
    }
    return out;
}

/**
 * Strip VHDL `--` line comments. Block comments aren't standard VHDL so we
 * don't bother. Newlines are preserved.
 */
function stripVhdlComments(src: string): string {
    return src.replace(/--[^\n]*/g, "");
}

/**
 * Lift VHDL port directions/types to the same `ModulePort` shape used by the
 * Verilog parser. Supports `std_logic`, `std_ulogic`, `std_logic_vector`,
 * `std_ulogic_vector`, `signed`, `unsigned`, and `bit`/`bit_vector` with
 * `(hi downto lo)` or `(lo to hi)` ranges. Anything else falls back to width 1.
 */
function parseVhdlPortLine(line: string): ModulePort[] {
    // VHDL allows `a, b, c : in std_logic_vector(7 downto 0);` — a single
    // declaration can name several ports of identical direction and type.
    const m = /^([\w\s,]+):\s*(in|out|inout|buffer)\s+([\s\S]+)$/i.exec(line.trim().replace(/;$/, ""));
    if (!m) { return []; }
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const dir = m[2].toLowerCase() as "in" | "out" | "inout" | "buffer";
    const typeStr = m[3].trim();

    let width = 1;
    const rangeM = /\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)/i.exec(typeStr);
    if (rangeM) {
        const a = parseInt(rangeM[1], 10), b = parseInt(rangeM[3], 10);
        width = Math.abs(a - b) + 1;
    }

    const direction: PortDirection =
        dir === "out" || dir === "buffer" ? "output" :
        dir === "inout" ? "inout" : "input";
    return names.map((name) => ({ name, direction, width }));
}

/**
 * Pull every `entity NAME is ... end entity NAME;` block out of a VHDL file.
 * Architectures aren't parsed — we only need the entity port list to wire the
 * imported component into the circuit editor.
 */
export function parseVhdlText(src: string, relPath: string): ModuleDecl[] {
    const text = stripVhdlComments(src);
    const out: ModuleDecl[] = [];
    const re = /\bentity\s+([A-Za-z_]\w*)\s+is\s+([\s\S]*?)\bend\s+(?:entity\s+)?(?:\1\s*)?;/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        const body = m[2];
        // Extract the `port ( ... );` block. Generics live alongside; we ignore them.
        const portM = /\bport\s*\(([\s\S]*?)\)\s*;/i.exec(body);
        const ports: ModulePort[] = [];
        if (portM) {
            // Split on `;` at paren-depth 0 so `vector(7 downto 0)` stays intact.
            const items: string[] = [];
            let depth = 0, current = "";
            for (const ch of portM[1]) {
                if (ch === "(") { depth++; current += ch; continue; }
                if (ch === ")") { depth--; current += ch; continue; }
                if (ch === ";" && depth === 0) { items.push(current); current = ""; continue; }
                current += ch;
            }
            if (current.trim()) { items.push(current); }
            for (const item of items) { ports.push(...parseVhdlPortLine(item)); }
        }
        out.push({ name, file: relPath, ports, instances: [] });
    }
    return out;
}

/** Parse every source file in the manifest and return a flat module list. */
export function parseWorkspaceModules(workspaceRoot: string, sourceFiles: string[]): ModuleDecl[] {
    const out: ModuleDecl[] = [];
    for (const rel of sourceFiles) {
        const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
        if (!/\.(v|sv|vh|svh)$/i.test(abs)) { continue; }
        let src: string;
        try { src = fs.readFileSync(abs, "utf8"); }
        catch { continue; }
        for (const decl of parseVerilogText(src, rel)) {
            out.push(decl);
        }
    }
    return out;
}

export interface HierarchyNode {
    /** Instance name (`u_adder`) — equals `decl.name` for the root. */
    instance: string;
    /** Module type — the entry in `decls` this node represents. */
    type: string;
    /** Source file declaring this module, if found. */
    file?: string;
    children: HierarchyNode[];
}

/**
 * Build a tree rooted at `topName` using the parsed module list. Recursive
 * cycles (e.g. mutually-instantiating modules through a bug) are guarded
 * by a visited set so we don't blow the stack.
 */
export function buildHierarchy(decls: ModuleDecl[], topName: string): HierarchyNode | undefined {
    const byName = new Map<string, ModuleDecl>();
    for (const d of decls) { if (!byName.has(d.name)) { byName.set(d.name, d); } }
    const top = byName.get(topName);
    if (!top) { return undefined; }

    const walk = (decl: ModuleDecl, instName: string, stack: Set<string>): HierarchyNode => {
        const node: HierarchyNode = { instance: instName, type: decl.name, file: decl.file, children: [] };
        if (stack.has(decl.name)) { return node; }
        stack.add(decl.name);
        for (const inst of decl.instances) {
            const sub = byName.get(inst.type);
            if (sub) { node.children.push(walk(sub, inst.name, stack)); }
            else { node.children.push({ instance: inst.name, type: inst.type, children: [] }); }
        }
        stack.delete(decl.name);
        return node;
    };
    return walk(top, top.name, new Set());
}
