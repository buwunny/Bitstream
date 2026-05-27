// Dirty flag + throttled doc-sync to the host. Webview panels can't block
// their own disposal, so the host keeps a copy of the current doc to either
// save or reopen on cancel.

import { state } from "./state";
import { vscode } from "./vscode-api";

function scheduleDocSync(): void {
  if (state._docSyncTimer) return;
  state._docSyncTimer = setTimeout(() => {
    state._docSyncTimer = null;
    vscode.postMessage({ type: "docSync", payload: state.doc });
  }, 250);
}

export function setDirty(v: boolean): void {
  if (state.dirty !== v) {
    state.dirty = v;
    vscode.postMessage({ type: "dirty", payload: v });
  }
  if (v) scheduleDocSync();
}
