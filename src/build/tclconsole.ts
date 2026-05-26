/**
 * tclconsole.ts
 * ----------------------------------------------------------------------------
 * Opens an interactive vendor Tcl shell inside a VS Code terminal — the
 * equivalent of dropping into the Vivado Tcl console or `quartus_sh -s`.
 * Useful for one-off queries (`get_parts`, `report_timing`,
 * `set_global_assignment`) without leaving the editor.
 *
 * We don't try to "embed" the shell — VS Code's terminal already gives us
 * scrollback, copy/paste, and ANSI. We just spawn the right binary with
 * the right args based on the project's vendor.
 */

import * as vscode from "vscode";
import { readManifest, manifestExists } from "../project/manifest";

const TERMINAL_NAME = "Bitstream Tcl";

/**
 * Re-use an existing Bitstream Tcl terminal if one is open; otherwise
 * spawn a new one with the vendor's shell command. Vivado: `-mode tcl`.
 * Quartus: `quartus_sh -s` (interactive shell mode).
 */
export function openTclConsole(workspaceRoot: string): void {
    if (!manifestExists(workspaceRoot)) {
        vscode.window.showErrorMessage("Bitstream: bitstream.json not found.");
        return;
    }
    const manifest = readManifest(workspaceRoot);
    const cfg = vscode.workspace.getConfiguration();

    // If a previous Tcl terminal is still alive, just bring it forward.
    const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
    if (existing) { existing.show(); return; }

    let shellPath: string;
    let shellArgs: string[];
    if (manifest.vendor === "xilinx") {
        shellPath = cfg.get<string>("hdlToolchain.vivadoPath", "vivado") || "vivado";
        shellArgs = ["-mode", "tcl"];
    } else {
        // Resolve quartus_sh under the configured bin directory; empty config
        // falls through to PATH.
        const dir = cfg.get<string>("hdlToolchain.quartusPath", "") || "";
        shellPath = dir ? `${dir.replace(/\/+$/, "")}/quartus_sh` : "quartus_sh";
        shellArgs = ["-s"];
    }

    const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        cwd: workspaceRoot,
        shellPath,
        shellArgs,
    });
    terminal.show();
}
