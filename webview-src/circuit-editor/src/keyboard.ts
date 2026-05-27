// Keyboard shortcuts: undo/redo, copy/paste, select-all, delete, wire-draw
// helpers (Esc cancels, Backspace pops the last waypoint), and the space-held
// pan modifier.

import { copySelection, pasteClipboard } from "./clipboard";
import { setDirty } from "./dirty";
import { svg } from "./dom";
import { redo, undo } from "./history";
import { render } from "./render";
import { syncColorPickerToSelection } from "./selection";
import { pushHistory, state } from "./state";

window.addEventListener("keydown", (e) => {
  if (document.activeElement && document.activeElement.tagName === "INPUT") return;
  const meta = e.ctrlKey || e.metaKey;

  if (e.code === "Space") {
    state.spaceHeld = true;
    svg.classList.add("spacing");
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    if (state.pendingWire) { state.pendingWire = null; render(); e.preventDefault(); return; }
  }
  // Backspace while drawing a wire pops the last waypoint instead of deleting.
  if ((e.key === "Backspace" || e.key === "Delete")
      && state.pendingWire
      && (state.pendingWire.waypoints ?? []).length) {
    state.pendingWire.waypoints.pop();
    e.preventDefault();
    render();
    return;
  }
  if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (meta && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
    e.preventDefault();
    redo();
    return;
  }
  if (meta && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(); return; }
  if (meta && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
  if (meta && e.key.toLowerCase() === "a") {
    e.preventDefault();
    state.selectedNodes = new Set(state.doc.nodes.map((n) => n.id));
    state.selectedWire = null;
    syncColorPickerToSelection();
    render();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (!state.selectedNodes.size && !state.selectedWire) return;
    e.preventDefault();
    pushHistory();
    if (state.selectedNodes.size) {
      state.doc.nodes = state.doc.nodes.filter((n) => !state.selectedNodes.has(n.id));
      state.doc.wires = state.doc.wires.filter(
        (w) => !state.selectedNodes.has(w.from.id) && !state.selectedNodes.has(w.to.id),
      );
      state.selectedNodes.clear();
    }
    if (state.selectedWire) {
      state.doc.wires = state.doc.wires.filter((w) => w !== state.selectedWire);
      state.selectedWire = null;
    }
    syncColorPickerToSelection();
    setDirty(true);
    render();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    state.spaceHeld = false;
    svg.classList.remove("spacing");
  }
});
