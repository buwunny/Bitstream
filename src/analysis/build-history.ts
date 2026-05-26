/**
 * build-history.ts
 * ----------------------------------------------------------------------------
 * Persists a slim snapshot of every successful build to
 * `.bitstream/history.json` so the Build History view can chart resource
 * and timing trends across commits.
 *
 * The file is intentionally append-only and small (we cap at the last 500
 * entries) so it's safe to check into git — diffing two history files
 * across a long-lived branch is a cheap regression check.
 *
 * Each entry records:
 *   • when the build ran (ms-epoch)
 *   • the git HEAD short SHA + subject line (if the workspace is a repo)
 *   • whether the working tree was dirty at build time
 *   • vendor / device / project name for context
 *   • headline resource counts + percents (LUT/FF/BRAM/DSP)
 *   • worst-clock WNS + best-clock Fmax for headline timing
 */

import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { BuildReport } from "./reports";
import { Vendor } from "../project/manifest";

const HISTORY_DIR = ".bitstream";
const HISTORY_FILE = "history.json";
const MAX_ENTRIES = 500;

export interface ResourceSnapshot {
    name: string;
    used: number;
    available: number;
    percent: number;
}

export interface HistoryEntry {
    timestamp: number;
    project_name: string;
    vendor: Vendor;
    device?: string;
    /** Short SHA (`git rev-parse --short HEAD`), if available. */
    commit?: string;
    /** First line of `git log -1 --format=%s` for the commit. */
    commit_subject?: string;
    /** True if `git status --porcelain` had output at build time. */
    dirty?: boolean;
    resources: ResourceSnapshot[];
    /** Worst setup slack across all clocks, ns. Negative ⇒ design failed timing. */
    worst_wns_ns?: number;
    /** Best (max) Fmax across all clocks, MHz. */
    best_fmax_mhz?: number;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function historyPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, HISTORY_DIR, HISTORY_FILE);
}

export function loadHistory(workspaceRoot: string): HistoryEntry[] {
    const p = historyPath(workspaceRoot);
    if (!fs.existsSync(p)) { return []; }
    try {
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) { return []; }
        // Be tolerant — we only require `timestamp` to be a number.
        return parsed.filter((e: any) => typeof e?.timestamp === "number");
    } catch {
        // Corrupt file: don't lose the user's data — leave on disk, return [].
        return [];
    }
}

/**
 * Append a snapshot derived from `report` to the history file. No-op when
 * the report is null (build emitted nothing parseable). Deduplicates against
 * the most recent entry if the timestamp and commit match — re-running a
 * build on the same commit shouldn't bloat the file with identical rows.
 */
export function appendEntry(workspaceRoot: string, report: BuildReport): HistoryEntry {
    const git = readGitState(workspaceRoot);
    const entry: HistoryEntry = {
        timestamp: report.generated_at ?? Date.now(),
        project_name: report.project_name,
        vendor: report.vendor,
        device: report.device,
        commit: git?.shortSha,
        commit_subject: git?.subject,
        dirty: git?.dirty,
        resources: report.resources.map((r) => ({
            name: r.name, used: r.used, available: r.available, percent: r.percent,
        })),
        worst_wns_ns: worstWns(report),
        best_fmax_mhz: bestFmax(report),
    };

    const all = loadHistory(workspaceRoot);
    // Drop the previous row if it's an obvious duplicate (same commit, same
    // numbers) — happens when a user re-opens the dashboard mid-iteration.
    const last = all[all.length - 1];
    if (last && isDuplicate(last, entry)) {
        all.pop();
    }
    all.push(entry);
    while (all.length > MAX_ENTRIES) { all.shift(); }

    const dir = path.join(workspaceRoot, HISTORY_DIR);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(historyPath(workspaceRoot), JSON.stringify(all, null, 2) + "\n", "utf8");
    return entry;
}

function isDuplicate(a: HistoryEntry, b: HistoryEntry): boolean {
    if (a.commit !== b.commit) { return false; }
    if (a.dirty !== b.dirty) { return false; }
    if ((a.worst_wns_ns ?? null) !== (b.worst_wns_ns ?? null)) { return false; }
    if ((a.best_fmax_mhz ?? null) !== (b.best_fmax_mhz ?? null)) { return false; }
    if (a.resources.length !== b.resources.length) { return false; }
    for (let i = 0; i < a.resources.length; i++) {
        if (a.resources[i].used !== b.resources[i].used) { return false; }
    }
    return true;
}

function worstWns(r: BuildReport): number | undefined {
    let worst: number | undefined;
    for (const c of r.clocks) {
        if (c.wns_ns == null) { continue; }
        if (worst === undefined || c.wns_ns < worst) { worst = c.wns_ns; }
    }
    return worst;
}

function bestFmax(r: BuildReport): number | undefined {
    let best: number | undefined;
    for (const c of r.clocks) {
        if (c.fmax_mhz == null) { continue; }
        if (best === undefined || c.fmax_mhz > best) { best = c.fmax_mhz; }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Git probing — best-effort, all-failures-return-undefined
// ---------------------------------------------------------------------------

interface GitState {
    shortSha: string;
    subject: string;
    dirty: boolean;
}

function readGitState(workspaceRoot: string): GitState | undefined {
    if (!fs.existsSync(path.join(workspaceRoot, ".git"))) { return undefined; }
    const sha = gitRun(workspaceRoot, ["rev-parse", "--short", "HEAD"]);
    if (!sha) { return undefined; }
    const subject = gitRun(workspaceRoot, ["log", "-1", "--format=%s"]) ?? "";
    const status = gitRun(workspaceRoot, ["status", "--porcelain"]) ?? "";
    return { shortSha: sha, subject, dirty: status.length > 0 };
}

function gitRun(cwd: string, args: string[]): string | undefined {
    try {
        const r = cp.spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000 });
        if (r.status !== 0) { return undefined; }
        return r.stdout.trim();
    } catch {
        return undefined;
    }
}
