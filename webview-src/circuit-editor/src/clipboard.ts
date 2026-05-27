// Copy / paste of the current node selection. Wires that cross the selection
// boundary are dropped because their endpoints would have nothing to attach
// to in the pasted copy.

import { setDirty } from "./dirty";
import { status } from "./dom";
import { render } from "./render";
import { syncColorPickerToSelection } from "./selection";
import { freshId, pushHistory, state } from "./state";
import type { CircuitNode, CircuitWire } from "./types";

export function copySelection(): void {
  if (!state.selectedNodes.size) { state.clipboard = null; return; }
  const nodes: CircuitNode[] = state.doc.nodes
    .filter((n) => state.selectedNodes.has(n.id))
    .map((n) => JSON.parse(JSON.stringify(n)));
  const ids = new Set(nodes.map((n) => n.id));
  const wires: CircuitWire[] = state.doc.wires
    .filter((w) => ids.has(w.from.id) && ids.has(w.to.id))
    .map((w) => JSON.parse(JSON.stringify(w)));
  state.clipboard = { nodes, wires };
  status.textContent = `Copied ${nodes.length} node${nodes.length === 1 ? "" : "s"}`;
  setTimeout(() => {
    if (status.textContent?.startsWith("Copied")) status.textContent = "";
  }, 1500);
}

export function pasteClipboard(): void {
  if (!state.clipboard || !state.clipboard.nodes.length) return;
  pushHistory();
  const OFFSET = 24;
  const idMap = new Map<string, string>();
  const newNodes: CircuitNode[] = state.clipboard.nodes.map((n) => {
    const fresh = freshId();
    idMap.set(n.id, fresh);
    return { ...n, id: fresh, x: n.x + OFFSET, y: n.y + OFFSET, label: n.label };
  });
  const newWires: CircuitWire[] = state.clipboard.wires.map((w) => {
    const waypoints = (w.waypoints ?? []).map((wp) => ({ x: wp.x + OFFSET, y: wp.y + OFFSET }));
    const out: CircuitWire = {
      from: { id: idMap.get(w.from.id)!, pin: w.from.pin, side: w.from.side },
      to: { id: idMap.get(w.to.id)!, pin: w.to.pin, side: w.to.side },
    };
    if (w.color) out.color = w.color;
    if (waypoints.length) out.waypoints = waypoints;
    return out;
  });
  state.doc.nodes.push(...newNodes);
  state.doc.wires.push(...newWires);
  state.selectedNodes = new Set(newNodes.map((n) => n.id));
  state.selectedWire = null;
  syncColorPickerToSelection();
  setDirty(true);
  render();
}
