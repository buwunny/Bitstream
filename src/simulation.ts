/**
 * simulation.ts
 * ----------------------------------------------------------------------------
 * Headless Verilog simulation via Icarus Verilog (iverilog + vvp). Picks a
 * testbench from the manifest (or the active editor), compiles every
 * non-testbench source plus the chosen TB, runs the resulting vvp image,
 * and offers to open the produced VCD/FST in GTKWave.
 *
 * The full flow is:
 *
 *     iverilog -g2012 -o build/sim.vvp <sources...> <tb>
 *     vvp     build/sim.vvp
 *     gtkwave <produced *.vcd/*.fst>          (optional, on user confirmation)
 *
 * The testbench is expected to emit a waveform via `$dumpfile`/`$dumpvars`
 * — that's the convention with iverilog. If no dump is produced we still
 * complete and stream stdout but skip the GTKWave step.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { BitstreamManifest, readManifest } from "./manifest";

export class Simulator {
    private readonly output: vscode.OutputChannel;

    constructor() {
        this.output = vscode.window.createOutputChannel("Bitstream: Simulation");
    }

    public dispose(): void { this.output.dispose(); }

    /**
     * Entry point bound to `bitstream.runSimulation`. If `tbPath` is given
     * we use it directly; otherwise we either pick from the manifest's
     * `testbenches` array (single → use, multiple → QuickPick) or fall
     * back to the active editor when it looks like a testbench.
     */
    public async run(workspaceRoot: string, tbPath?: string): Promise<void> {
        const manifest = readManifest(workspaceRoot);
        const tb = tbPath ?? await this.pickTestbench(workspaceRoot, manifest);
        if (!tb) { return; }

        const cfg = vscode.workspace.getConfiguration();
        const iverilog = cfg.get<string>("hdlToolchain.iverilogPath", "iverilog") || "iverilog";
        const vvp      = cfg.get<string>("hdlToolchain.vvpPath", "vvp")           || "vvp";

        const buildDir = path.join(workspaceRoot, "build");
        if (!fs.existsSync(buildDir)) { fs.mkdirSync(buildDir, { recursive: true }); }
        const vvpImage = path.join(buildDir, "sim.vvp");

        // Anything in source_files that isn't a testbench, plus the chosen TB.
        // Sources are passed as relative paths so the simulator's working
        // directory is the workspace root and `$dumpfile("x.vcd")` lands there.
        const sources = manifest.source_files.filter((f) => !manifest.testbenches.includes(f));
        const args = ["-g2012", "-o", path.relative(workspaceRoot, vvpImage), ...sources, tb];

        this.output.show(true);
        this.output.appendLine(`\n=== Compiling testbench: ${tb} ===`);
        try {
            await this.exec(iverilog, args, workspaceRoot);
        } catch (err: any) {
            this.output.appendLine(`\nCompile failed: ${err.message}`);
            vscode.window.showErrorMessage(`Simulation compile failed: ${err.message}`);
            return;
        }

        this.output.appendLine(`\n=== Running ${path.basename(vvpImage)} ===`);
        // Snapshot existing wave artefacts so we can detect ones newly produced.
        const before = new Map<string, number>();
        for (const f of waveformsIn(workspaceRoot)) { before.set(f, mtimeOf(f)); }
        try {
            await this.exec(vvp, [path.relative(workspaceRoot, vvpImage)], workspaceRoot);
        } catch (err: any) {
            this.output.appendLine(`\nSimulation aborted: ${err.message}`);
            return;
        }

        const produced = waveformsIn(workspaceRoot).filter((f) => {
            const prev = before.get(f);
            return prev === undefined || mtimeOf(f) > prev;
        });
        if (!produced.length) {
            this.output.appendLine("\n(No VCD/FST waveform produced — add $dumpfile/$dumpvars to your testbench to view waveforms.)");
            return;
        }
        const wave = produced[0];
        const pick = await vscode.window.showInformationMessage(
            `Simulation complete. Open ${path.basename(wave)} in GTKWave?`,
            "Open in GTKWave", "Skip",
        );
        if (pick === "Open in GTKWave") {
            const gtkwave = cfg.get<string>("hdlToolchain.gtkwavePath", "gtkwave") || "gtkwave";
            cp.spawn(gtkwave, [wave], { cwd: workspaceRoot, detached: true, stdio: "ignore" }).unref();
        }
    }

    private async pickTestbench(workspaceRoot: string, manifest: BitstreamManifest): Promise<string | undefined> {
        // Prefer the active editor when it sits in the manifest's testbench
        // list — matches the common "edit + run" loop.
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (active) {
            const rel = path.relative(workspaceRoot, active).split(path.sep).join("/");
            if (manifest.testbenches.includes(rel)) { return rel; }
        }
        if (!manifest.testbenches.length) {
            vscode.window.showErrorMessage("No testbenches in the project. Add a file named `*_tb.sv` or `tb_*.sv`.");
            return undefined;
        }
        if (manifest.testbenches.length === 1) { return manifest.testbenches[0]; }
        const picked = await vscode.window.showQuickPick(manifest.testbenches, {
            placeHolder: "Select testbench to simulate",
        });
        return picked;
    }

    /** spawn a child and stream output to the simulation channel; rejects on non-zero exit. */
    private exec(command: string, args: string[], cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.output.appendLine(`$ ${command} ${args.join(" ")}`);
            const proc = cp.spawn(command, args, { cwd, shell: false });
            proc.stdout.on("data", (d) => this.output.append(d.toString()));
            proc.stderr.on("data", (d) => this.output.append(d.toString()));
            proc.on("error", (err) => reject(new Error(`Failed to spawn ${command}: ${err.message}`)));
            proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
        });
    }
}

// ---- waveform discovery helpers -------------------------------------------

function waveformsIn(root: string): string[] {
    const out: string[] = [];
    const exts = [".vcd", ".fst", ".lxt", ".lxt2"];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            if (ent.name === ".git" || ent.name === "node_modules" || ent.name === "vivado_project" || ent.name === "quartus_project") { continue; }
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(abs); }
            else if (ent.isFile() && exts.includes(path.extname(ent.name).toLowerCase())) { out.push(abs); }
        }
    };
    walk(root);
    return out;
}

function mtimeOf(file: string): number {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
