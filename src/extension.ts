/**
 * extension.ts
 * ----------------------------------------------------------------------------
 * Activation entry point and orchestrator. This file glues together:
 *
 *   • ProjectWizard           — Webview UI for creating new projects.
 *   • Toolchain               — vendor Tcl generation + child_process execs.
 *   • VerilatorLinter         — on-save Verilator → Problems-tab diagnostics.
 *   • LanguageClient          — verible-verilog-ls LSP client (Verilog/SV).
 *   • FileSystemWatcher       — keeps `bitstream.json` in sync with `*.v`,
 *                                `*.sv`, `*.vhd` files that appear or vanish
 *                                from the workspace.
 *   • Status Bar items        — clickable "Build Bitstream" /
 *                                "Upload to Board" shortcuts.
 *
 * Lifecycle: VS Code calls `activate(context)` once. Everything that owns OS
 * resources (LSP client, watcher, linter, status bar) is pushed onto
 * `context.subscriptions` so VS Code can clean up at deactivate.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
} from "vscode-languageclient/node";

import { ProjectWizard } from "./wizard";
import { Toolchain } from "./toolchain";
import { VerilatorLinter } from "./linter";
import { CircuitEditor } from "./circuit_editor/circuit";
import { PinPlanner } from "./pinplanner";
import { ReportsDashboard } from "./reports-dashboard";
import { CriticalPathsView } from "./critical-paths-view";
import { CdcLinter } from "./cdc-lint";
import { RtlSchematic } from "./rtl-schematic";
import { Simulator } from "./simulation";
import { openTclConsole } from "./tclconsole";
import { ProjectExplorer, ProjectTreeItem } from "./explorer";
import { parseWorkspaceModules } from "./hierarchy";
import {
    BitstreamManifest,
    MANIFEST_FILE,
    HDL_EXTENSIONS,
    CONSTRAINT_EXTENSIONS,
    manifestExists,
    readManifest,
    writeManifest,
    writeGitignore,
    findFilesByExt,
    isTestbenchFile,
} from "./manifest";

let lspClient: LanguageClient | undefined;
let linter: VerilatorLinter | undefined;
let cdcLinter: CdcLinter | undefined;
let toolchain: Toolchain | undefined;
let simulator: Simulator | undefined;
let explorer: ProjectExplorer | undefined;
let buildStatus: vscode.StatusBarItem | undefined;
let uploadStatus: vscode.StatusBarItem | undefined;
let topModuleStatus: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    toolchain = new Toolchain();
    linter = new VerilatorLinter();
    cdcLinter = new CdcLinter();
    simulator = new Simulator();
    context.subscriptions.push(toolchain, linter, cdcLinter, simulator);

    // Project Explorer TreeView. Registered up-front so users always see the
    // panel (with a "no manifest" hint until they run the wizard). The
    // provider re-reads the manifest on every refresh, so we just need to
    // fire refresh() at the right moments.
    explorer = new ProjectExplorer(() => currentWorkspaceRoot());
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("bitstream.projectExplorer", explorer),
    );

    // ---- Commands ---------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand("bitstream.newProject", () => {
            ProjectWizard.show(context.extensionUri);
        }),
        vscode.commands.registerCommand("bitstream.syncManifest", async () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            await syncManifest(root);
            vscode.window.showInformationMessage("Bitstream: manifest synchronised.");
        }),
        vscode.commands.registerCommand("bitstream.regenerateGitignore", async () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            const manifest = readManifest(root);
            writeGitignore(root, manifest.vendor);
            vscode.window.showInformationMessage("Bitstream: .gitignore regenerated.");
        }),
        vscode.commands.registerCommand("bitstream.buildBitstream", async () => {
            const root = requireWorkspaceRoot();
            if (!root || !toolchain) { return; }
            try {
                await toolchain.build(root);
                // Auto-open the resource/timing dashboard if the build emitted
                // parseable reports. Silent no-op when nothing was generated.
                ReportsDashboard.refreshAfterBuild(root);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Bitstream build failed: ${err.message ?? err}`);
                // Partial reports are still useful for diagnosis — surface
                // whatever's on disk even if the build itself failed.
                ReportsDashboard.refreshAfterBuild(root);
            }
        }),
        vscode.commands.registerCommand("bitstream.uploadBitstream", async () => {
            const root = requireWorkspaceRoot();
            if (!root || !toolchain) { return; }
            try {
                await toolchain.upload(root);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Bitstream upload failed: ${err.message ?? err}`);
            }
        }),
        vscode.commands.registerCommand("bitstream.lintActive", async () => {
            await linter!.lintActiveEditor();
        }),
        vscode.commands.registerCommand("bitstream.newCircuit", () => {
            CircuitEditor.show(context.extensionUri);
        }),
        vscode.commands.registerCommand("bitstream.openCircuit", async (uri?: vscode.Uri) => {
            let target = uri;
            if (!target) {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { Circuit: ["bscircuit.json", "json"] },
                });
                target = picked?.[0];
            }
            if (target) {
                CircuitEditor.show(context.extensionUri, target);
            }
        }),

        // ---- New (Vivado/Quartus-style) commands ---------------------------

        vscode.commands.registerCommand("bitstream.setTopModule", async (arg?: ProjectTreeItem | string) => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            const manifest = readManifest(root);
            // Tree-context-menu click hands us the item directly when the
            // user picks "Set as Top" from a source row; otherwise prompt.
            let chosen: string | undefined;
            if (arg && typeof arg === "object" && (arg as ProjectTreeItem).moduleType) {
                chosen = (arg as ProjectTreeItem).moduleType;
            } else if (typeof arg === "string") {
                chosen = arg;
            } else {
                const decls = parseWorkspaceModules(root, manifest.source_files);
                if (!decls.length) {
                    vscode.window.showErrorMessage("No Verilog modules found in sources.");
                    return;
                }
                chosen = await vscode.window.showQuickPick(
                    decls.map((d) => ({ label: d.name, description: d.file })),
                    { placeHolder: "Select top module" },
                ).then((p) => p?.label);
            }
            if (!chosen) { return; }
            manifest.top_module = chosen;
            writeManifest(root, manifest);
            updateTopModuleStatus(manifest.top_module);
            explorer?.refresh();
            vscode.window.showInformationMessage(`Top module set: ${chosen}`);
        }),

        vscode.commands.registerCommand("bitstream.openPinPlanner", () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            PinPlanner.show(context.extensionUri, root);
        }),

        vscode.commands.registerCommand("bitstream.runSimulation", async (arg?: ProjectTreeItem) => {
            const root = requireWorkspaceRoot();
            if (!root || !simulator) { return; }
            // When invoked from the Testbenches context menu we get the
            // tree item with a relative file path attached.
            const tb = arg && (arg as ProjectTreeItem).file;
            await simulator.run(root, tb);
        }),

        vscode.commands.registerCommand("bitstream.openTclConsole", () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            openTclConsole(root);
        }),

        vscode.commands.registerCommand("bitstream.showReportsDashboard", () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            ReportsDashboard.show(root);
        }),

        vscode.commands.registerCommand("bitstream.showRtlSchematic", async () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            await RtlSchematic.show(root);
        }),

        vscode.commands.registerCommand("bitstream.showCriticalPaths", () => {
            const root = requireWorkspaceRoot();
            if (!root) { return; }
            CriticalPathsView.show(root);
        }),

        vscode.commands.registerCommand("bitstream.runCdcLint", () => {
            const root = requireWorkspaceRoot();
            if (!root || !cdcLinter) { return; }
            const manifest = readManifest(root);
            const count = cdcLinter.run(root, manifest.source_files);
            if (count === 0) {
                vscode.window.showInformationMessage("Bitstream CDC: no clock-domain crossings detected.");
            } else {
                vscode.window.showWarningMessage(
                    `Bitstream CDC: ${count} potential crossing${count === 1 ? "" : "s"} flagged — see Problems panel.`,
                );
            }
        }),

        vscode.commands.registerCommand("bitstream.refreshExplorer", () => {
            explorer?.refresh();
        }),

        // Opens the Settings UI scoped to the Bitstream extension's
        // `hdlToolchain.*` properties — the closest VS Code lets us get to a
        // dedicated config panel without rolling our own webview.
        vscode.commands.registerCommand("bitstream.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "@ext:bitstream.bitstream");
        }),
    );

    // ---- LSP client (verible) --------------------------------------------
    // Verible is a separate process; we speak LSP-over-stdio to it. If the
    // user hasn't installed it the client will error on start — we surface
    // that as an info message rather than a hard failure, because the rest
    // of the extension (build/upload/linter) still works without LSP.
    await startLanguageClient(context);

    // ---- Workspace manifest bootstrap & file watcher ---------------------
    const root = currentWorkspaceRoot();
    if (root && manifestExists(root)) {
        // Make sure the manifest reflects current on-disk reality on activation.
        await syncManifest(root);
        registerHdlWatcher(context, root);
        registerStatusBar(context);
    } else {
        // No manifest yet: still register a watcher that adopts the workspace
        // the moment a wizard run drops `bitstream.json` into it.
        const manifestWatcher = vscode.workspace.createFileSystemWatcher(`**/${MANIFEST_FILE}`);
        context.subscriptions.push(manifestWatcher);
        manifestWatcher.onDidCreate(async (uri: vscode.Uri) => {
            const newRoot = path.dirname(uri.fsPath);
            await syncManifest(newRoot);
            registerHdlWatcher(context, newRoot);
            registerStatusBar(context);
        });
    }
}

export async function deactivate(): Promise<void> {
    if (lspClient) {
        await lspClient.stop();
        lspClient = undefined;
    }
}

// ---- Helpers --------------------------------------------------------------

function currentWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function requireWorkspaceRoot(): string | undefined {
    const root = currentWorkspaceRoot();
    if (!root) {
        vscode.window.showErrorMessage("Bitstream: no workspace folder is open.");
        return undefined;
    }
    if (!manifestExists(root)) {
        vscode.window.showErrorMessage(
            `Bitstream: ${MANIFEST_FILE} not found. Run "Bitstream: New Project Wizard" first.`,
        );
        return undefined;
    }
    return root;
}

async function startLanguageClient(context: vscode.ExtensionContext): Promise<void> {
    const cfg = vscode.workspace.getConfiguration();
    if (!cfg.get<boolean>("hdlToolchain.enableLsp", true)) {
        return;
    }
    const veribleBin = cfg.get<string>("hdlToolchain.veribleLsPath", "verible-verilog-ls") || "verible-verilog-ls";

    // Probe the binary before handing it to the LSP client. A missing or
    // non-executable verible causes child_process.spawn to fail asynchronously
    // and the client then tries to write the LSP initialize message into a
    // closed pipe — surfaces as the dreaded "Unexpected SIGPIPE / EPIPE" in
    // the extension host log.
    if (!isExecutableAvailable(veribleBin)) {
        vscode.window.showWarningMessage(
            `Bitstream: verible-verilog-ls not found at "${veribleBin}". HDL IntelliSense disabled — install verible or set hdlToolchain.veribleLsPath / hdlToolchain.enableLsp.`,
        );
        return;
    }

    // NB: do NOT set `transport: TransportKind.stdio`. vscode-languageclient
    // appends `--stdio` to argv when that's set, and verible-verilog-ls
    // rejects unknown flags (it speaks LSP on plain stdio by default, no
    // flag required). Leaving transport undefined uses the same in-process
    // stdio path without polluting argv.
    const serverOptions: ServerOptions = {
        run: { command: veribleBin, args: [] },
        debug: { command: veribleBin, args: [] },
    };
    // The file watcher is its own disposable; without registering it on the
    // extension context it would leak on reload and (worse) keep firing into
    // a stopped client, producing "write after destroy" spam in the host log.
    const lspFileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{v,sv,vh,svh}");
    context.subscriptions.push(lspFileWatcher);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: "file", language: "verilog" },
            { scheme: "file", language: "systemverilog" },
        ],
        // Verible doesn't watch the filesystem itself — letting VS Code feed it
        // change events keeps its index in sync with the editor.
        synchronize: {
            fileEvents: lspFileWatcher,
        },
        // Surface verible's stderr (e.g., its startup banner, parse errors)
        // through a dedicated channel rather than dropping it on the floor.
        outputChannel: vscode.window.createOutputChannel("Bitstream Verible LSP"),
        revealOutputChannelOn: 4, // RevealOutputChannelOn.Never
    };

    const client = new LanguageClient("bitstreamVerible", "Bitstream Verible LSP", serverOptions, clientOptions);
    lspClient = client;
    // Stop the client cooperatively on deactivate / reload. We swallow the
    // rejection because by the time dispose fires the transport may already
    // be torn down — re-raising would just log noise.
    context.subscriptions.push({ dispose: () => { client.stop().catch(() => { /* swallow */ }); } });
    try {
        await client.start();
    } catch (err: any) {
        lspClient = undefined;
        vscode.window.showWarningMessage(
            `Bitstream: failed to start verible LSP (${err.message ?? err}). IntelliSense will be disabled.`,
        );
    }
}

/**
 * Best-effort check that `bin` can actually be exec'd. Accepts absolute paths
 * (stat + X_OK) and bare names looked up on PATH (we shell out to `command -v`
 * via spawnSync because Node has no portable PATH lookup).
 */
function isExecutableAvailable(bin: string): boolean {
    if (!bin) { return false; }
    if (path.isAbsolute(bin) || bin.includes(path.sep)) {
        try {
            fs.accessSync(bin, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    const lookup = process.platform === "win32"
        ? spawnSync("where", [bin], { encoding: "utf8" })
        : spawnSync("command", ["-v", bin], { encoding: "utf8", shell: true });
    return lookup.status === 0 && lookup.stdout.trim().length > 0;
}

/**
 * Watch the workspace for HDL / constraint file churn and re-sync the
 * manifest in place. The watcher reacts to add/delete only — content
 * changes don't affect the manifest, so we skip onDidChange to keep the
 * sync cost negligible.
 */
function registerHdlWatcher(context: vscode.ExtensionContext, root: string): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, "**/*.{v,sv,vh,svh,vhd,vhdl,xdc,sdc}"),
    );
    const trigger = () => { syncManifest(root).catch(() => { /* swallow — best-effort */ }); };
    watcher.onDidCreate(trigger);
    watcher.onDidDelete(trigger);
    // File content changes inform the hierarchy parser (module decls /
    // instantiations) — refresh the tree, but skip rewriting the manifest.
    watcher.onDidChange(() => explorer?.refresh());
    context.subscriptions.push(watcher);

    // The manifest itself can change out-of-band (hand-edit, save from
    // Pin Planner). Refresh the tree + status bar when it does.
    const manifestWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, MANIFEST_FILE),
    );
    const onManifestChange = () => {
        explorer?.refresh();
        try { updateTopModuleStatus(readManifest(root).top_module); } catch { /* ignore */ }
    };
    manifestWatcher.onDidChange(onManifestChange);
    manifestWatcher.onDidCreate(onManifestChange);
    context.subscriptions.push(manifestWatcher);
}

/**
 * Reconcile the manifest's file arrays with on-disk reality. HDL files are
 * split into `source_files` (synthesizable) and `testbenches` based on the
 * filename convention (`*_tb.*` / `tb_*.*`). User-owned fields
 * (`project_name`, `vendor`, `device`, `top_module`, `pin_map`) are
 * preserved verbatim.
 */
async function syncManifest(root: string): Promise<void> {
    if (!manifestExists(root)) { return; }
    const current = readManifest(root);
    const allHdl = findFilesByExt(root, HDL_EXTENSIONS);
    const sources: string[] = [];
    const testbenches: string[] = [];
    for (const f of allHdl) {
        (isTestbenchFile(f) ? testbenches : sources).push(f);
    }
    const next: BitstreamManifest = {
        ...current,
        source_files: sources,
        testbenches,
        constraints: findFilesByExt(root, CONSTRAINT_EXTENSIONS),
    };
    if (
        arraysEqual(current.source_files, next.source_files) &&
        arraysEqual(current.testbenches, next.testbenches) &&
        arraysEqual(current.constraints, next.constraints)
    ) {
        // Even when nothing changed on disk, refresh the explorer in case a
        // user-edited manifest field (top_module, pin_map) was the trigger.
        explorer?.refresh();
        return;
    }
    writeManifest(root, next);
    explorer?.refresh();
}

function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
    return true;
}

/**
 * Three left-aligned status bar items. We register them once per session
 * and let users click them rather than memorising command-palette names.
 * Higher priority renders further left within the Left group.
 */
function registerStatusBar(context: vscode.ExtensionContext): void {
    if (buildStatus || uploadStatus) { return; }
    buildStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    buildStatus.text = "$(tools) Build Bitstream";
    buildStatus.tooltip = "Synthesize and write a bitstream for the current Bitstream project.";
    buildStatus.command = "bitstream.buildBitstream";
    buildStatus.show();

    uploadStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    uploadStatus.text = "$(zap) Upload to Board";
    uploadStatus.tooltip = "Program the connected FPGA over JTAG.";
    uploadStatus.command = "bitstream.uploadBitstream";
    uploadStatus.show();

    // Always-visible top-module indicator — click to switch tops without
    // hunting through the command palette.
    topModuleStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    topModuleStatus.command = "bitstream.setTopModule";
    topModuleStatus.tooltip = "Click to choose the project's top module.";
    topModuleStatus.show();

    context.subscriptions.push(buildStatus, uploadStatus, topModuleStatus);

    // Seed the indicator from the manifest on startup.
    const root = currentWorkspaceRoot();
    if (root && manifestExists(root)) {
        try { updateTopModuleStatus(readManifest(root).top_module); } catch { /* ignore */ }
    }
}

function updateTopModuleStatus(top: string | undefined): void {
    if (!topModuleStatus) { return; }
    topModuleStatus.text = top ? `$(symbol-class) Top: ${top}` : `$(symbol-class) Top: (unset)`;
}
