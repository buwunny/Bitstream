/**
 * manifest.ts
 * ----------------------------------------------------------------------------
 * Single source of truth for the `bitstream.json` workspace manifest. Every
 * other module (toolchain, linter, extension) reads/writes the manifest
 * through this module so the on-disk schema lives in exactly one place.
 *
 * The manifest is intentionally human-friendly JSON: it is checked into git
 * and acts as the canonical definition of "what is this project?", which
 * vendor-specific Tcl scripts are generated from on demand. Vendor IDE
 * project directories themselves are treated as throwaway build artefacts.
 */

import * as fs from "fs";
import * as path from "path";

export type Vendor = "xilinx" | "intel";

export interface BitstreamManifest {
    project_name: string;
    vendor: Vendor;
    device: string;
    /**
     * Top-level module name passed to synth. Optional during early editing;
     * commands that need it (build, pin planner) prompt the user when unset.
     */
    top_module?: string;
    source_files: string[];
    /** Files matching testbench naming conventions — kept out of source_files. */
    testbenches: string[];
    constraints: string[];
    /** port name → device pin assignment (e.g. clk → W5). Used to emit XDC/QSF. */
    pin_map?: Record<string, string>;
}

export const MANIFEST_FILE = "bitstream.json";

/** HDL extensions that the file watcher and manifest-sync care about. */
export const HDL_EXTENSIONS = [".v", ".sv", ".vh", ".svh", ".vhd", ".vhdl"];

/** Constraint extensions per vendor. Used by syncManifest() and wizard scaffolding. */
export const CONSTRAINT_EXTENSIONS = [".xdc", ".sdc", ".qsf", ".tcl"];

export function manifestPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, MANIFEST_FILE);
}

export function manifestExists(workspaceRoot: string): boolean {
    return fs.existsSync(manifestPath(workspaceRoot));
}

export function readManifest(workspaceRoot: string): BitstreamManifest {
    const raw = fs.readFileSync(manifestPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<BitstreamManifest>;
    // Be tolerant of partial manifests so older projects keep working.
    return {
        project_name: parsed.project_name ?? path.basename(workspaceRoot),
        vendor: (parsed.vendor as Vendor) ?? "xilinx",
        device: parsed.device ?? "",
        top_module: parsed.top_module,
        source_files: parsed.source_files ?? [],
        testbenches: parsed.testbenches ?? [],
        constraints: parsed.constraints ?? [],
        pin_map: parsed.pin_map,
    };
}

export function writeManifest(workspaceRoot: string, manifest: BitstreamManifest): void {
    // Stable key order + trailing newline keeps git diffs minimal.
    const ordered: BitstreamManifest = {
        project_name: manifest.project_name,
        vendor: manifest.vendor,
        device: manifest.device,
        ...(manifest.top_module ? { top_module: manifest.top_module } : {}),
        source_files: [...manifest.source_files].sort(),
        testbenches: [...manifest.testbenches].sort(),
        constraints: [...manifest.constraints].sort(),
        ...(manifest.pin_map && Object.keys(manifest.pin_map).length
            ? { pin_map: Object.fromEntries(Object.entries(manifest.pin_map).sort(([a], [b]) => a.localeCompare(b))) }
            : {}),
    };
    fs.writeFileSync(manifestPath(workspaceRoot), JSON.stringify(ordered, null, 2) + "\n", "utf8");
}

/** Filename matches a testbench convention: `*_tb.{ext}` or `tb_*.{ext}`. */
export function isTestbenchFile(relPath: string): boolean {
    const base = path.basename(relPath).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, "");
    return stem.endsWith("_tb") || stem.startsWith("tb_");
}

/**
 * Recursively walk `root` collecting files whose extension is in `exts`.
 * Skips common junk + vendor build folders so a stray `vivado_project/`
 * never leaks into the manifest.
 */
export function findFilesByExt(root: string, exts: string[]): string[] {
    const ignore = new Set([
        "node_modules", ".git", "out", "build", ".bitstream",
        "vivado_project", "quartus_project",
        ".Xil", "output_files", "db", "incremental_db",
    ]);
    const out: string[] = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            if (ignore.has(ent.name)) { continue; }
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(abs);
            } else if (ent.isFile()) {
                const ext = path.extname(ent.name).toLowerCase();
                if (exts.includes(ext)) {
                    out.push(path.relative(root, abs).split(path.sep).join("/"));
                }
            }
        }
    };
    walk(root);
    return out.sort();
}

/**
 * Build a vendor-aware .gitignore. The manifest is the source of truth, so
 * everything regenerable (vendor project dirs, logs, journals) is ignored —
 * `git clone` + manifest is enough to rebuild the whole project.
 */
export function generateGitignore(vendor: Vendor): string {
    const common = [
        "# --- Bitstream auto-generated ---",
        "# Vendor projects are throwaway; bitstream.json is the source of truth.",
        "",
        "# Editor / OS",
        ".vscode/",
        ".DS_Store",
        "*.log",
        "*.swp",
        "",
        "# Bitstream build outputs",
        "out/",
        "build/",
        "",
    ];

    const xilinx = [
        "# Xilinx / Vivado",
        "vivado_project/",
        ".Xil/",
        "*.jou",
        "*.str",
        "*.backup.jou",
        "*.backup.log",
        "vivado*.log",
        "vivado*.jou",
        "webtalk*.log",
        "webtalk*.jou",
        "*.cache/",
        "*.hw/",
        "*.ip_user_files/",
        "*.runs/",
        "*.sim/",
        "*.srcs/",
        "",
    ];

    const intel = [
        "# Intel / Quartus",
        "quartus_project/",
        "output_files/",
        "db/",
        "incremental_db/",
        "*.qws",
        "*.rpt",
        "*.summary",
        "*.smsg",
        "*.pin",
        "*.pof",
        "*.sof",
        "*.jdi",
        "*.jic",
        "",
    ];

    const sections = [...common];
    if (vendor === "xilinx") { sections.push(...xilinx, ...intel); }
    else { sections.push(...intel, ...xilinx); }
    return sections.join("\n");
}

export function writeGitignore(workspaceRoot: string, vendor: Vendor): void {
    fs.writeFileSync(path.join(workspaceRoot, ".gitignore"), generateGitignore(vendor), "utf8");
}
