// Selection-color: applying, clearing, and syncing the toolbar color picker
// to whatever the user has selected (single wire, multiple nodes, or nothing).

import { btnClearColor, colorPicker } from "./dom";
import { setDirty } from "./dirty";
import { pushHistory } from "./history";
import { render } from "./render";
import { DEFAULT_PICKER_COLOR, state } from "./state";

function isHexColor(v: string | null | undefined): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v ?? "");
}

export function selectionColor(): string | null {
  if (state.selectedWire) return state.selectedWire.color ?? null;
  if (!state.selectedNodes.size) return null;
  let color: string | null = null;
  for (const id of state.selectedNodes) {
    const node = state.doc.nodes.find((n) => n.id === id);
    if (!node || !node.color) return null;
    if (color == null) color = node.color;
    else if (color !== node.color) return null;
  }
  return color;
}

export function syncColorPickerToSelection(): void {
  const hasSelection = !!state.selectedWire || state.selectedNodes.size > 0;
  const color = selectionColor();
  colorPicker.disabled = !hasSelection;
  btnClearColor.disabled = !hasSelection || !color;
  const next = color && isHexColor(color) ? color : DEFAULT_PICKER_COLOR;
  if (colorPicker.value !== next) colorPicker.value = next;
}

export function applySelectionColor(color: string): void {
  if (state.selectedWire) {
    if (state.selectedWire.color === color) return;
    pushHistory();
    state.selectedWire.color = color;
    setDirty(true);
    render();
    return;
  }
  if (!state.selectedNodes.size) return;
  let changed = false;
  for (const id of state.selectedNodes) {
    const node = state.doc.nodes.find((n) => n.id === id);
    if (node && node.color !== color) { changed = true; break; }
  }
  if (!changed) return;
  pushHistory();
  for (const id of state.selectedNodes) {
    const node = state.doc.nodes.find((n) => n.id === id);
    if (node) node.color = color;
  }
  setDirty(true);
  render();
}

export function clearSelectionColor(): void {
  if (state.selectedWire) {
    if (!state.selectedWire.color) return;
    pushHistory();
    delete state.selectedWire.color;
    setDirty(true);
    render();
    return;
  }
  if (!state.selectedNodes.size) return;
  let changed = false;
  for (const id of state.selectedNodes) {
    const node = state.doc.nodes.find((n) => n.id === id);
    if (node && node.color) { changed = true; break; }
  }
  if (!changed) return;
  pushHistory();
  for (const id of state.selectedNodes) {
    const node = state.doc.nodes.find((n) => n.id === id);
    if (node && node.color) delete node.color;
  }
  setDirty(true);
  render();
}
