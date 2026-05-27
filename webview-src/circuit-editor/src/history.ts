// Undo/redo via full-doc JSON snapshots. Selection is intentionally not
// snapshotted so after undo the user sees an empty selection — predictable
// when they edit immediately afterwards.

import { setDirty } from "./dirty";
import { moduleNameInput } from "./dom";
import { rebuildModulePalette } from "./palette";
import { render } from "./render";
import { snapshot, state } from "./state";
import { syncColorPickerToSelection } from "./selection";
import { updateRoutingButton } from "./toolbar";

// pushHistory itself lives in state.ts so routing/interaction can call it
// without dragging in the DOM-touching resync helpers exported here.
export { pushHistory } from "./state";

export function undo(): void {
  if (!state.history.length) return;
  state.future.push(snapshot());
  state.doc = JSON.parse(state.history.pop()!);
  resyncAfterReplace();
}

export function redo(): void {
  if (!state.future.length) return;
  state.history.push(snapshot());
  state.doc = JSON.parse(state.future.pop()!);
  resyncAfterReplace();
}

export function resyncAfterReplace(): void {
  let maxN = 0;
  for (const n of state.doc.nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  state.nextId = maxN + 1;
  moduleNameInput.value = state.doc.moduleName || "circuit";
  rebuildModulePalette();
  state.selectedNodes.clear();
  state.selectedWire = null;
  state.pendingWire = null;
  updateRoutingButton();
  syncColorPickerToSelection();
  setDirty(true);
  render();
}
