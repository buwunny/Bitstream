// Canvas-level pointer interaction: pan, rubber-band select, wire-draw
// waypoint accumulation, wheel zoom. Per-element handlers (node, pin,
// waypoint mousedown) are attached during render — see render.ts.

import { svg } from "./dom";
import { setDirty } from "./dirty";
import { render } from "./render";
import { syncColorPickerToSelection } from "./selection";
import { shapeOf } from "./shapes";
import { HISTORY_LIMIT, orthogonalMode, snap, state } from "./state";
import { applyView, clientToContent } from "./view";
import type { Point } from "./types";

svg.addEventListener("mousemove", (e) => {
  if (state.panning) {
    state.view.tx = state.panning.startTx + (e.clientX - state.panning.startX);
    state.view.ty = state.panning.startTy + (e.clientY - state.panning.startY);
    applyView();
    return;
  }
  const dwp = state.draggingWaypoint;
  if (dwp) {
    // Promote a ghost joint or L-corner into a real waypoint on first
    // movement, so a click-without-drag on an implicit handle stays a no-op.
    if (dwp.pendingMaterialize) {
      dwp.wire.waypoints = dwp.pendingMaterialize;
      dwp.pendingMaterialize = undefined;
    }
    if (dwp.pendingInsert) {
      const wps = (dwp.wire.waypoints ?? []).slice();
      wps.splice(dwp.pendingInsert.at, 0, dwp.pendingInsert.point);
      dwp.wire.waypoints = wps;
      dwp.pendingInsert = undefined;
    }
    const pt = clientToContent(e);
    const wps = dwp.wire.waypoints ?? [];
    const wp = wps[dwp.idx];
    if (wp) {
      wp.x = snap(pt.x - dwp.dx);
      wp.y = snap(pt.y - dwp.dy);
      dwp.moved = true;
      render();
    }
    return;
  }
  const drag = state.dragging;
  if (drag) {
    const pt = clientToContent(e);
    drag.moved = true;
    for (const id of state.selectedNodes) {
      const node = state.doc.nodes.find((x) => x.id === id);
      const off = drag.offsets.get(id);
      if (node && off) { node.x = snap(pt.x - off.dx); node.y = snap(pt.y - off.dy); }
    }
    render();
  } else if (state.rubber) {
    const pt = clientToContent(e);
    state.rubber.x1 = pt.x; state.rubber.y1 = pt.y;
    render();
  } else if (state.pendingWire) {
    state.pendingWire.mouse = clientToContent(e);
    render();
  }
});

window.addEventListener("mouseup", () => {
  if (state.dragging) {
    if (state.dragging.moved) {
      // We snapshotted pre-drag state but only commit it if the drag actually
      // changed positions — otherwise plain clicks would pollute history.
      state.history.push(state.dragging.pre);
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
      state.future.length = 0;
      setDirty(true);
    }
    state.dragging = null;
  }
  if (state.draggingWaypoint) {
    if (state.draggingWaypoint.moved) {
      state.history.push(state.draggingWaypoint.pre);
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
      state.future.length = 0;
      setDirty(true);
    }
    state.draggingWaypoint = null;
  }
  if (state.rubber) {
    finalizeRubber();
    state.rubber = null;
    render();
  }
  if (state.panning) {
    state.panning = null;
    svg.classList.remove("panning");
  }
});

function finalizeRubber(): void {
  const r = state.rubber!;
  const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
  const x2 = Math.max(r.x0, r.x1), y2 = Math.max(r.y0, r.y1);
  for (const n of state.doc.nodes) {
    const s = shapeOf(n);
    const hit = !(n.x + s.w < x || n.x > x2 || n.y + s.h < y || n.y > y2);
    if (hit) state.selectedNodes.add(n.id);
  }
  syncColorPickerToSelection();
}

svg.addEventListener("mousedown", (e) => {
  if (e.target !== svg && (e.target as SVGElement).id !== "viewport") return;
  // Pan with middle-mouse or space-held left-mouse; otherwise start rubber-band.
  if (e.button === 1 || (e.button === 0 && state.spaceHeld)) {
    state.panning = {
      startX: e.clientX, startY: e.clientY,
      startTx: state.view.tx, startTy: state.view.ty,
    };
    svg.classList.add("panning");
    e.preventDefault();
    return;
  }
  // Right-click cancels an in-progress wire draw.
  if (e.button === 2 && state.pendingWire) {
    state.pendingWire = null;
    e.preventDefault();
    render();
    return;
  }
  if (e.button !== 0) return;
  // Quartus-style: while drawing a straight wire, a click on empty canvas adds
  // an axis-snapped routing waypoint instead of cancelling the draw.
  if (state.pendingWire && orthogonalMode()) {
    const corner = pendingCornerPoint();
    if (corner) {
      state.pendingWire.waypoints = state.pendingWire.waypoints ?? [];
      state.pendingWire.waypoints.push(corner);
      render();
    }
    return;
  }
  state.pendingWire = null;
  if (!e.shiftKey) { state.selectedNodes.clear(); state.selectedWire = null; }
  syncColorPickerToSelection();
  const pt = clientToContent(e);
  state.rubber = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
  render();
});

// Suppress default context menu and cancel any in-progress wire draw — bubbles
// up from nodes/pins too, so this works canvas-wide.
svg.addEventListener("contextmenu", (e) => {
  if (state.pendingWire) { state.pendingWire = null; e.preventDefault(); render(); }
});

/**
 * Where the in-progress wire's next corner sits — the cursor position snapped
 * to whichever axis it has travelled further along from the previous waypoint
 * (or source pin). Returns null if the pending source has gone away.
 */
function pendingCornerPoint(): Point | null {
  if (!state.pendingWire) return null;
  const tail = pendingTailPoint();
  if (!tail) return null;
  const m = state.pendingWire.mouse;
  const dx = Math.abs(m.x - tail.x), dy = Math.abs(m.y - tail.y);
  // Snap only the free (cursor-side) axis; preserve the tail-side coord so the
  // segment from tail → corner stays purely horizontal or vertical.
  return dx >= dy ? { x: snap(m.x), y: tail.y } : { x: tail.x, y: snap(m.y) };
}

function pendingTailPoint(): Point | null {
  if (!state.pendingWire) return null;
  const wps = state.pendingWire.waypoints ?? [];
  if (wps.length) return wps[wps.length - 1];
  const src = state.doc.nodes.find((n) => n.id === state.pendingWire!.from.id);
  if (!src) return null;
  const fromShape = shapeOf(src);
  const p = state.pendingWire.from.side === "in"
    ? fromShape.ins[state.pendingWire.from.pin]
    : fromShape.outs[state.pendingWire.from.pin];
  if (!p) return null;
  return {
    x: src.x + (state.pendingWire.from.side === "in" ? 0 : fromShape.w),
    y: src.y + p.y,
  };
}

// Wheel zoom, anchored on the cursor so the point under the mouse stays put.
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const factor = Math.exp(-e.deltaY * 0.0015);
  const next = Math.max(0.2, Math.min(4, state.view.scale * factor));
  // Solve: (mx - tx) / scale == (mx - tx') / next  →  tx' = mx - (mx - tx) * (next/scale)
  state.view.tx = mx - (mx - state.view.tx) * (next / state.view.scale);
  state.view.ty = my - (my - state.view.ty) * (next / state.view.scale);
  state.view.scale = next;
  applyView();
}, { passive: false });
