/**
 * timing-badge.ts
 * ----------------------------------------------------------------------------
 * Status-bar item that surfaces the worst WNS across all clocks after each
 * build. Goes red when slack is negative so the user notices timing failure
 * without having to open the dashboard.
 *
 * Refreshed by Toolchain.build via `TimingBadge.refreshAfterBuild`. Clicking
 * the badge opens the full Resource & Timing dashboard.
 */

import * as vscode from "vscode";
import { BuildReport, loadBuildReport } from "./reports";
import { readManifest } from "../project/manifest";

export class TimingBadge implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        // Sit just to the right of the build/upload buttons. Lower priority
        // renders further right within the Left group.
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
        this.item.command = "bitstream.showReportsDashboard";
    }

    /**
     * Reload the most recent build report for `workspaceRoot` and update the
     * badge. Hides the badge entirely if no parseable reports exist yet —
     * pre-build state should not look like a passing build.
     */
    public refresh(workspaceRoot: string): void {
        let report: BuildReport | null = null;
        try {
            const manifest = readManifest(workspaceRoot);
            report = loadBuildReport(workspaceRoot, manifest.vendor, manifest.project_name);
        } catch {
            report = null;
        }
        this.render(report);
    }

    private render(report: BuildReport | null): void {
        if (!report || !report.clocks.length) {
            this.item.hide();
            return;
        }
        // Worst-case slack across all clocks. Some entries may omit wns_ns
        // (e.g. unconstrained clocks) — skip those.
        let worstName: string | undefined;
        let worstWns: number | undefined;
        for (const c of report.clocks) {
            if (typeof c.wns_ns !== "number" || !Number.isFinite(c.wns_ns)) { continue; }
            if (worstWns === undefined || c.wns_ns < worstWns) {
                worstWns = c.wns_ns;
                worstName = c.name;
            }
        }
        if (worstWns === undefined) {
            this.item.hide();
            return;
        }

        const wnsStr = `${worstWns >= 0 ? "+" : ""}${worstWns.toFixed(3)} ns`;
        if (worstWns < 0) {
            this.item.text = `$(error) WNS ${wnsStr}`;
            this.item.tooltip = `Timing FAILED — worst clock "${worstName}" has ${wnsStr} setup slack. Click to open the dashboard.`;
            this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        } else {
            this.item.text = `$(check) WNS ${wnsStr}`;
            this.item.tooltip = `Timing met — worst clock "${worstName}" has ${wnsStr} setup slack. Click to open the dashboard.`;
            this.item.backgroundColor = undefined;
        }
        this.item.show();
    }

    public dispose(): void {
        this.item.dispose();
    }
}
