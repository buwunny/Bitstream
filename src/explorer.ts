/**
 * explorer.ts
 * ----------------------------------------------------------------------------
 * Project Explorer TreeDataProvider — a Vivado/Quartus-style sidebar that
 * groups everything about the current project into navigable categories:
 *
 *     Bitstream Project (<name> · <vendor>/<device>)
 *     ├── Sources              (top module marked ★)
 *     ├── Testbenches          (run-simulation context menu)
 *     ├── Constraints
 *     ├── Hierarchy (top: foo) (rooted at manifest.top_module)
 *     └── Pin Map              (port → device pin)
 *
 * The tree is rebuilt from the manifest + parsed Verilog every time
 * `refresh()` fires. Refresh is wired in extension.ts to manifest writes,
 * the HDL file watcher, and explicit user action.
 */

import * as vscode from "vscode";
import * as path from "path";
import { BitstreamManifest, manifestExists, readManifest } from "./manifest";
import {
    HierarchyNode, ModuleDecl,
    parseWorkspaceModules, buildHierarchy,
} from "./hierarchy";

type NodeKind =
    | "category"
    | "source" | "testbench" | "constraint"
    | "hierarchy" | "pin" | "info";

export class ProjectTreeItem extends vscode.TreeItem {
    public readonly kind: NodeKind;
    /** Workspace-relative file path for `source`/`testbench`/`constraint`. */
    public readonly file?: string;
    /** Module type for `hierarchy` items. */
    public readonly moduleType?: string;
    /** Port name for `pin` items. */
    public readonly portName?: string;
    /** Pre-built children — leaves are filled in lazily during getChildren. */
    public readonly children: ProjectTreeItem[];

    constructor(
        label: string,
        kind: NodeKind,
        children: ProjectTreeItem[] = [],
        opts: {
            description?: string;
            tooltip?: string;
            icon?: string;
            file?: string;
            moduleType?: string;
            portName?: string;
            command?: vscode.Command;
            contextValue?: string;
            highlight?: boolean;
        } = {},
    ) {
        super(label, children.length > 0 || kind === "category" || kind === "hierarchy"
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None);
        this.kind = kind;
        this.children = children;
        this.file = opts.file;
        this.moduleType = opts.moduleType;
        this.portName = opts.portName;
        if (opts.description) { this.description = opts.description; }
        if (opts.tooltip) { this.tooltip = opts.tooltip; }
        if (opts.icon) { this.iconPath = new vscode.ThemeIcon(opts.icon); }
        if (opts.command) { this.command = opts.command; }
        if (opts.contextValue) { this.contextValue = opts.contextValue; }
        if (opts.highlight) {
            // Top module is highlighted with a star prefix; VS Code only
            // bolds via resourceUri, which we don't want to use for non-files.
            this.label = "★ " + label;
        }
    }
}

export class ProjectExplorer implements vscode.TreeDataProvider<ProjectTreeItem> {
    private readonly _onDidChange = new vscode.EventEmitter<ProjectTreeItem | undefined | void>();
    public readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private readonly workspaceRoot: () => string | undefined) {}

    public refresh(): void {
        this._onDidChange.fire();
    }

    public getTreeItem(el: ProjectTreeItem): vscode.TreeItem { return el; }

    public getChildren(el?: ProjectTreeItem): ProjectTreeItem[] {
        if (el) { return el.children; }
        return this.buildRoot();
    }

    private buildRoot(): ProjectTreeItem[] {
        const root = this.workspaceRoot();
        if (!root) {
            return [new ProjectTreeItem("No workspace open", "info", [], { icon: "warning" })];
        }
        if (!manifestExists(root)) {
            return [new ProjectTreeItem(
                "No bitstream.json — run \"Bitstream: New Project Wizard\"",
                "info", [], { icon: "warning",
                    command: { command: "bitstream.newProject", title: "New Project" } },
            )];
        }
        const manifest = readManifest(root);

        const header = new ProjectTreeItem(
            manifest.project_name,
            "category",
            [
                this.sourcesCategory(root, manifest),
                this.testbenchesCategory(root, manifest),
                this.constraintsCategory(root, manifest),
                this.hierarchyCategory(root, manifest),
                this.pinMapCategory(manifest),
            ],
            {
                description: `${manifest.vendor} · ${manifest.device || "no device"}`,
                tooltip: `Top: ${manifest.top_module ?? "(unset)"}`,
                icon: "circuit-board",
                contextValue: "project",
            },
        );
        return [header];
    }

    private sourcesCategory(root: string, m: BitstreamManifest): ProjectTreeItem {
        const items = m.source_files.map((rel) => {
            const isTop = !!m.top_module && this.declaresTopModule(root, rel, m.top_module);
            return new ProjectTreeItem(path.basename(rel), "source", [], {
                description: path.dirname(rel) === "." ? "" : path.dirname(rel),
                tooltip: rel + (isTop ? "  (top module)" : ""),
                icon: "file-code",
                file: rel,
                contextValue: isTop ? "source-top" : "source",
                highlight: isTop,
                command: {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [vscode.Uri.file(path.join(root, rel))],
                },
            });
        });
        return new ProjectTreeItem(`Sources (${items.length})`, "category", items, { icon: "folder-library" });
    }

    private testbenchesCategory(root: string, m: BitstreamManifest): ProjectTreeItem {
        const items = m.testbenches.map((rel) => new ProjectTreeItem(
            path.basename(rel), "testbench", [], {
                description: path.dirname(rel) === "." ? "" : path.dirname(rel),
                tooltip: rel,
                icon: "beaker",
                file: rel,
                contextValue: "testbench",
                command: {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [vscode.Uri.file(path.join(root, rel))],
                },
            }));
        return new ProjectTreeItem(`Testbenches (${items.length})`, "category", items, { icon: "beaker" });
    }

    private constraintsCategory(root: string, m: BitstreamManifest): ProjectTreeItem {
        const items = m.constraints.map((rel) => new ProjectTreeItem(
            path.basename(rel), "constraint", [], {
                description: path.dirname(rel) === "." ? "" : path.dirname(rel),
                tooltip: rel,
                icon: "law",
                file: rel,
                contextValue: "constraint",
                command: {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [vscode.Uri.file(path.join(root, rel))],
                },
            }));
        return new ProjectTreeItem(`Constraints (${items.length})`, "category", items, { icon: "law" });
    }

    private hierarchyCategory(root: string, m: BitstreamManifest): ProjectTreeItem {
        if (!m.top_module) {
            return new ProjectTreeItem(
                "Hierarchy (no top set)", "category",
                [new ProjectTreeItem("Click to set top module", "info", [], {
                    icon: "arrow-right",
                    command: { command: "bitstream.setTopModule", title: "Set Top Module" },
                })],
                { icon: "type-hierarchy" },
            );
        }
        const decls = parseWorkspaceModules(root, m.source_files);
        const tree = buildHierarchy(decls, m.top_module);
        if (!tree) {
            return new ProjectTreeItem(
                `Hierarchy (top: ${m.top_module})`, "category",
                [new ProjectTreeItem(`Module "${m.top_module}" not found in sources`, "info", [], { icon: "warning" })],
                { icon: "type-hierarchy" },
            );
        }
        return new ProjectTreeItem(
            `Hierarchy (top: ${m.top_module})`, "category",
            [this.hierarchyToItem(root, tree, decls)],
            { icon: "type-hierarchy" },
        );
    }

    private hierarchyToItem(root: string, node: HierarchyNode, decls: ModuleDecl[]): ProjectTreeItem {
        const children = node.children.map((c) => this.hierarchyToItem(root, c, decls));
        const isOrphan = !node.file;
        const tooltip = isOrphan
            ? `${node.type} (no source found)`
            : `${node.instance} : ${node.type}  →  ${node.file}`;
        return new ProjectTreeItem(
            node.instance === node.type ? node.type : `${node.instance} : ${node.type}`,
            "hierarchy", children,
            {
                tooltip,
                icon: isOrphan ? "question" : "symbol-class",
                moduleType: node.type,
                contextValue: "hierarchy",
                command: node.file ? {
                    command: "vscode.open",
                    title: "Open",
                    arguments: [vscode.Uri.file(path.join(root, node.file))],
                } : undefined,
            },
        );
    }

    private pinMapCategory(m: BitstreamManifest): ProjectTreeItem {
        const entries = Object.entries(m.pin_map ?? {});
        const items = entries.map(([port, pin]) => new ProjectTreeItem(
            port, "pin", [], {
                description: `→ ${pin}`,
                tooltip: `${port} assigned to pin ${pin}`,
                icon: "circle-small-filled",
                portName: port,
                contextValue: "pin",
            }));
        if (!items.length) {
            items.push(new ProjectTreeItem(
                "No pins assigned — open Pin Planner", "info", [], {
                    icon: "arrow-right",
                    command: { command: "bitstream.openPinPlanner", title: "Open Pin Planner" },
                }));
        }
        return new ProjectTreeItem(
            `Pin Map (${entries.length})`, "category", items,
            { icon: "symbol-misc" },
        );
    }

    /**
     * Cheap heuristic to flag a source as the one that declares the top
     * module: read first 64 KiB and look for `module <topName>`. Avoids
     * pulling the full parser on every refresh.
     */
    private declaresTopModule(root: string, rel: string, top: string): boolean {
        try {
            const abs = path.join(root, rel);
            const fd = require("fs").openSync(abs, "r");
            const buf = Buffer.alloc(64 * 1024);
            const n = require("fs").readSync(fd, buf, 0, buf.length, 0);
            require("fs").closeSync(fd);
            const text = buf.slice(0, n).toString("utf8");
            return new RegExp(`\\bmodule\\s+${top}\\b`).test(text);
        } catch { return false; }
    }
}
