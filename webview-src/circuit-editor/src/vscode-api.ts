import type { VsCodeApi } from "./types";

// acquireVsCodeApi must only be called once per webview lifetime. We grab it
// at module-load and hand the same handle to every importer.
export const vscode: VsCodeApi = window.acquireVsCodeApi!();
