// Frame-rate-coupled render. Multiple mousemove/keydown bursts inside one
// frame collapse to a single DOM update — the dominant cost at scale. Call
// sites use render(); the actual draw is _render().

import { setDirty } from "./dirty";
import { status, svgEl, viewport } from "./dom";
import {
  bezier,
  defaultRouteJoints,
  insertWaypoint,
  junctionPoints,
  manhattanGhostCorners,
  simplifyWaypoints,
  tapPointOnWire,
  wirePath,
} from "./routing";
import { syncColorPickerToSelection } from "./selection";
import { orthogonalMode, pushHistory, routingStyle, snapshot, state } from "./state";
import { pinPos, pinWidth, shapeOf } from "./shapes";
import { clientToContent, rectIntersects, visibleRect } from "./view";
import { vscode } from "./vscode-api";
import type { CircuitNode, CircuitWire, PinSide, Point } from "./types";

export function render(): void {
  if (state._renderPending) return;
  state._renderPending = true;
  requestAnimationFrame(() => { state._renderPending = false; _render(); });
}

function _render(): void {
  viewport.innerHTML = "";

  // Level-of-detail tier — when zoomed out, drop pin labels and type stripes
  // (medium) or skip everything except node outlines (low).
  const lod: "low" | "medium" | "high" =
    state.view.scale < 0.25 ? "low" : state.view.scale < 0.5 ? "medium" : "high";
  // Cull nodes outside the visible content rect (with a margin for partial
  // overlaps). At 1.0 zoom on a typical screen, this is a no-op.
  const vis = visibleRect();
  const MARGIN = 120;
  const vx = vis.x - MARGIN, vy = vis.y - MARGIN, vw = vis.w + 2 * MARGIN, vh = vis.h + 2 * MARGIN;

  const culled = new Set<string>();
  for (const n of state.doc.nodes) {
    const s = shapeOf(n);
    if (!rectIntersects(n.x, n.y, s.w, s.h, vx, vy, vw, vh)) culled.add(n.id);
  }

  // Wires first so node bodies overlay endpoints. A wire is drawn unless
  // *both* endpoints are culled — otherwise it'd disappear when one end is
  // pulled off-screen during a drag.
  const straightMode = orthogonalMode();
  for (const w of state.doc.wires) {
    if (culled.has(w.from.id) && culled.has(w.to.id)) continue;
    const src = state.doc.nodes.find((n) => n.id === w.from.id);
    const dst = state.doc.nodes.find((n) => n.id === w.to.id);
    if (!src || !dst) continue;
    const a = pinPos(src, w.from.side, w.from.pin);
    const b = pinPos(dst, w.to.side, w.to.pin);
    const width = Math.max(pinWidth(src, "out", w.from.pin), pinWidth(dst, "in", w.to.pin));
    const isSelected = state.selectedWire === w;
    const hasColor = !!w.color;
    const klass = "wire"
      + (width > 1 ? " bus" : "")
      + (isSelected ? " selected" : "")
      + (hasColor ? " has-color" : "");
    const path = svgEl("path", { d: wirePath(a, b, w), class: klass });
    if (hasColor) path.style.setProperty("--wire-color", w.color!);
    path.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      // Shift+click on a wire taps into its net: start a new pending wire
      // from the same source, inheriting the existing wire's waypoints up
      // to the click point so the new branch shares the same trunk.
      if (e.shiftKey && !state.pendingWire) {
        const tap = tapPointOnWire(w, clientToContent(e));
        if (tap) {
          state.pendingWire = {
            from: { ...w.from },
            mouse: tap.tap,
            waypoints: [...tap.prefix, tap.tap],
          };
          state.selectedWire = null;
          state.selectedNodes.clear();
          syncColorPickerToSelection();
          render();
          return;
        }
      }
      state.selectedWire = w;
      state.selectedNodes.clear();
      syncColorPickerToSelection();
      render();
    });
    path.addEventListener("dblclick", (e) => {
      if (!straightMode) return;
      e.stopPropagation();
      insertWaypoint(w, clientToContent(e));
      render();
    });
    viewport.appendChild(path);
    if (width > 1 && lod === "high") {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 4;
      const tag = svgEl("text", { class: "wire-label", x: mx, y: my, "text-anchor": "middle" });
      tag.textContent = `[${width}]`;
      viewport.appendChild(tag);
    }
    // Waypoint handles render only for the selected wire in straight mode.
    // For wires with no explicit waypoints, expose the two implicit Z-route
    // corners as ghost handles so the user can grab and reshape the default
    // route without having to dbl-click first.
    if (isSelected && straightMode) {
      const wps = w.waypoints ?? [];
      if (wps.length) {
        wps.forEach((wp, idx) => {
          const handle = svgEl("rect", {
            class: "waypoint", x: wp.x - 5, y: wp.y - 5, width: 10, height: 10, rx: 2, ry: 2,
          });
          handle.addEventListener("mousedown", (e) => onWaypointDown(e, w, idx));
          viewport.appendChild(handle);
        });
        // Ghost handles on the renderer-inserted L-corners (manhattan only).
        // First drag promotes the corner into a real waypoint at the right
        // index — same materialize-on-move pattern as the empty-wire joints.
        if (routingStyle() === "manhattan") {
          const ghosts = manhattanGhostCorners(a, b, wps);
          ghosts.forEach((g) => {
            const handle = svgEl("rect", {
              class: "waypoint ghost",
              x: g.pos.x - 5, y: g.pos.y - 5, width: 10, height: 10, rx: 2, ry: 2,
            });
            handle.addEventListener("mousedown", (e) => onImplicitCornerDown(e, w, g.insertAt, g.pos));
            viewport.appendChild(handle);
          });
        }
      } else {
        const joints = defaultRouteJoints(w);
        joints.forEach((wp, idx) => {
          const handle = svgEl("rect", {
            class: "waypoint ghost",
            x: wp.x - 5, y: wp.y - 5, width: 10, height: 10, rx: 2, ry: 2,
          });
          handle.addEventListener("mousedown", (e) => onImplicitJointDown(e, w, idx, joints));
          viewport.appendChild(handle);
        });
      }
    }
  }

  if (state.pendingWire) {
    const src = state.doc.nodes.find((n) => n.id === state.pendingWire!.from.id);
    if (src) {
      const a = pinPos(src, state.pendingWire.from.side, state.pendingWire.from.pin);
      const wps = state.pendingWire.waypoints ?? [];
      let d: string;
      if (straightMode) {
        // Lines through committed waypoints, then an axis-snapped L from the
        // tail to the cursor so the preview is always orthogonal.
        const tail = wps.length ? wps[wps.length - 1] : a;
        const m = state.pendingWire.mouse;
        const dx = Math.abs(m.x - tail.x), dy = Math.abs(m.y - tail.y);
        const corner = dx >= dy ? { x: m.x, y: tail.y } : { x: tail.x, y: m.y };
        const parts = [`M ${a.x} ${a.y}`];
        for (const wp of wps) parts.push(`L ${wp.x} ${wp.y}`);
        parts.push(`L ${corner.x} ${corner.y}`);
        parts.push(`L ${m.x} ${m.y}`);
        d = parts.join(" ");
      } else {
        d = bezier(a, state.pendingWire.mouse);
      }
      viewport.appendChild(svgEl("path", { d, class: "wire pending" }));
      // Dots at committed waypoints so the user can see what's been laid down.
      for (const wp of wps) {
        viewport.appendChild(svgEl("circle", { cx: wp.x, cy: wp.y, r: 3, class: "waypoint" }));
      }
    }
  }

  for (const n of state.doc.nodes) {
    if (culled.has(n.id)) continue;
    renderNode(n, lod);
  }

  // Junction markers: a filled dot anywhere 3+ wire-branches converge.
  // Each pin contributes one branch (its gate stub), each wire endpoint one
  // branch, each interior waypoint two (in + out segments). A single wire's
  // bend totals 2 — no dot. A Y-fanout at a pin (pin + 2 wires) is 3 — dot.
  // A T-tap (endpoint + pass-through) is also 3 — dot.
  for (const { p, busWidth } of junctionPoints()) {
    const r = busWidth > 1 ? 4.5 : 3.5;
    viewport.appendChild(svgEl("circle", { class: "junction", cx: p.x, cy: p.y, r }));
  }

  if (state.rubber) {
    const x = Math.min(state.rubber.x0, state.rubber.x1);
    const y = Math.min(state.rubber.y0, state.rubber.y1);
    const w = Math.abs(state.rubber.x1 - state.rubber.x0);
    const h = Math.abs(state.rubber.y1 - state.rubber.y0);
    viewport.appendChild(svgEl("rect", { class: "rubber", x, y, width: w, height: h }));
  }
}

function makePin(cx: number, cy: number, width: number, handler: (e: MouseEvent) => void): SVGCircleElement {
  const el = svgEl("circle", { class: "pin" + (width > 1 ? " bus" : ""), cx, cy, r: width > 1 ? 5 : 4 });
  el.addEventListener("mousedown", handler);
  return el;
}

function pinLabel(x: number, y: number, text: string, anchor: "start" | "end"): SVGTextElement {
  const t = svgEl("text", { class: "pin-label", x, y, "text-anchor": anchor });
  t.textContent = text;
  return t;
}

function renderNode(n: CircuitNode, lod: "low" | "medium" | "high"): void {
  const s = shapeOf(n);
  const isModule = n.type === "MODULE";
  const gateUri = !isModule && (window.GATE_URIS ?? {})[n.type];
  const hasColor = !!n.color;
  const g = svgEl("g", {
    class: "node"
      + (state.selectedNodes.has(n.id) ? " selected" : "")
      + (isModule ? " module" : "")
      + (hasColor ? " has-color" : ""),
    transform: `translate(${n.x},${n.y})`,
  });
  if (hasColor) g.style.setProperty("--node-color", n.color!);

  if (gateUri) {
    // SVG icon fills node bounds; stubs reach x=0 (left) and x=100→s.w (right)
    // so wire endpoints land exactly on the pin circles.
    g.appendChild(svgEl("image", {
      href: gateUri, x: 0, y: 0, width: s.w, height: s.h, preserveAspectRatio: "none",
    }));
    g.appendChild(svgEl("rect", { class: "node-tint", x: 0, y: 0, width: s.w, height: s.h, rx: 3, ry: 3 }));
    // Transparent rect provides selection stroke and a reliable hit target.
    g.appendChild(svgEl("rect", { class: "hit", x: 0, y: 0, width: s.w, height: s.h, rx: 3, ry: 3 }));
  } else {
    g.appendChild(svgEl("rect", { x: 0, y: 0, width: s.w, height: s.h, rx: 4, ry: 4 }));
  }

  if (lod !== "low") {
    // For gate icons the type is conveyed visually; show the instance label
    // below the symbol. For I/O and MODULE keep it inside the box.
    const isIO = n.type === "INPUT" || n.type === "OUTPUT";
    const labelY = gateUri && !isIO ? s.h + 12 : (isModule ? 14 : s.h / 2 + 4);
    const labelEl = svgEl("text", { class: "label", x: s.w / 2, y: labelY });
    labelEl.textContent = n.label;
    g.appendChild(labelEl);
    if (isModule) {
      const typeEl = svgEl("text", { class: "type", x: s.w / 2, y: s.h - 4 });
      typeEl.textContent = n.moduleRef ?? "";
      g.appendChild(typeEl);
    }
  }

  // Pins are always rendered so wiring remains possible at any zoom.
  s.ins.forEach((p, i) => {
    const w = pinWidth(n, "in", i);
    g.appendChild(makePin(0, p.y, w, (e) => onPinDown(e, n, "in", i)));
    if (p.lbl && lod === "high") g.appendChild(pinLabel(10, p.y + 3, p.lbl, "start"));
  });
  s.outs.forEach((p, i) => {
    const w = pinWidth(n, "out", i);
    g.appendChild(makePin(s.w, p.y, w, (e) => onPinDown(e, n, "out", i)));
    if (p.lbl && lod === "high") g.appendChild(pinLabel(s.w - 10, p.y + 3, p.lbl, "end"));
  });

  g.addEventListener("mousedown", (e) => onNodeDown(e, n));
  g.addEventListener("dblclick", () => {
    // MODULE nodes drill down to their source design; everything else opens
    // the label-rename prompt.
    if (isModule) {
      const iface = (state.doc.modules ?? {})[n.moduleRef ?? ""];
      if (iface && iface.file) {
        vscode.postMessage({ type: "openModule", file: iface.file });
      } else {
        status.textContent = "Module has no file path; save this circuit and re-import.";
        setTimeout(() => { status.textContent = ""; }, 2500);
      }
      return;
    }
    renameNode(n);
  });
  viewport.appendChild(g);
}

function renameNode(n: CircuitNode): void {
  const hint = (n.type === "INPUT" || n.type === "OUTPUT") ? "  (use name[7:0] for buses)" : "";
  const v = prompt(`Label for ${n.type}${hint}`, n.label);
  if (v == null) return;
  const trimmed = v.trim();
  if (!trimmed || trimmed === n.label) return;
  pushHistory();
  n.label = trimmed;
  setDirty(true);
  render();
}

// ----- Pin / waypoint / node mousedown -------------------------------------
// These live here (not in interaction.ts) because they're attached during
// render to per-element handlers. Canvas-level handlers are in interaction.ts.

export function onNodeDown(e: MouseEvent, n: CircuitNode): void {
  if ((e.target as Element).classList.contains("pin")) return;
  // Shift toggles membership; plain click on an unselected node replaces.
  if (e.shiftKey) {
    if (state.selectedNodes.has(n.id)) state.selectedNodes.delete(n.id);
    else state.selectedNodes.add(n.id);
  } else if (!state.selectedNodes.has(n.id)) {
    state.selectedNodes.clear();
    state.selectedNodes.add(n.id);
  }
  state.selectedWire = null;
  syncColorPickerToSelection();

  // Drag all currently-selected nodes as a group with per-node grab offsets
  // so members keep their relative positions during the drag.
  const pt = clientToContent(e);
  const offsets = new Map<string, { dx: number; dy: number }>();
  for (const id of state.selectedNodes) {
    const node = state.doc.nodes.find((x) => x.id === id);
    if (node) offsets.set(id, { dx: pt.x - node.x, dy: pt.y - node.y });
  }
  state.dragging = { offsets, moved: false, pre: snapshot() };
  render();
}

export function onPinDown(e: MouseEvent, node: CircuitNode, side: PinSide, idx: number): void {
  e.stopPropagation();
  if (!state.pendingWire) {
    state.pendingWire = { from: { id: node.id, pin: idx, side }, mouse: clientToContent(e), waypoints: [] };
    render();
    return;
  }
  const a = state.pendingWire.from;
  const b = { id: node.id, pin: idx, side };
  // Same side is invalid (out→out or in→in); a→a on the same exact pin is a
  // no-op. Out→in on the same node IS allowed — that's a self-loop, routed
  // around the gate by defaultRoute.
  if (a.side === b.side) { state.pendingWire = null; render(); return; }
  if (a.id === b.id && a.pin === b.pin) { state.pendingWire = null; render(); return; }
  const srcRef = a.side === "out" ? a : b;
  const dstRef = a.side === "in" ? a : b;
  // Reverse waypoints if the user drew the wire backwards (started from the sink).
  // Waypoints are stored from source → sink in the final wire.
  const drawn = (state.pendingWire.waypoints ?? []).slice();
  const orderedWps = a === srcRef ? drawn : drawn.reverse();
  // If the trailing waypoint isn't axis-aligned with the destination pin, add
  // an automatic L-corner so the final segment is orthogonal (Quartus style).
  const dstNode = state.doc.nodes.find((n) => n.id === dstRef.id);
  const srcNode = state.doc.nodes.find((n) => n.id === srcRef.id);
  if (dstNode && srcNode) {
    const dstPt = pinPos(dstNode, dstRef.side, dstRef.pin);
    const tail = orderedWps.length
      ? orderedWps[orderedWps.length - 1]
      : pinPos(srcNode, srcRef.side, srcRef.pin);
    if (tail.x !== dstPt.x && tail.y !== dstPt.y && orthogonalMode()) {
      const dx = Math.abs(dstPt.x - tail.x), dy = Math.abs(dstPt.y - tail.y);
      // Keep the corner's tail-axis coord exactly tail's value so the segment
      // from tail to corner stays purely H or V.
      const corner = dx >= dy ? { x: dstPt.x, y: tail.y } : { x: tail.x, y: dstPt.y };
      orderedWps.push(corner);
    }
  }
  state.pendingWire = null;
  pushHistory();
  // Replace any existing driver on this sink — each input pin has one driver.
  state.doc.wires = state.doc.wires.filter((w) => !(w.to.id === dstRef.id && w.to.pin === dstRef.pin));
  const wire: CircuitWire = { from: srcRef, to: dstRef };
  if (orderedWps.length) wire.waypoints = orderedWps;
  state.doc.wires.push(wire);
  simplifyWaypoints(wire);
  setDirty(true);
  render();
}

export function onWaypointDown(e: MouseEvent, wire: CircuitWire, idx: number): void {
  e.stopPropagation();
  const wps: Point[] = (wire.waypoints ?? []).slice();
  if (!wps[idx]) return;
  if (e.shiftKey) {
    pushHistory();
    wps.splice(idx, 1);
    wire.waypoints = wps.length ? wps : undefined;
    setDirty(true);
    render();
    return;
  }
  const pt = clientToContent(e);
  state.draggingWaypoint = {
    wire, idx, dx: pt.x - wps[idx].x, dy: pt.y - wps[idx].y, moved: false, pre: snapshot(),
  };
}

/**
 * Mousedown on an L-corner inserted by the manhattan renderer. The corner
 * isn't yet in wire.waypoints, so we stage an insertion to happen on first
 * real movement (same pattern as onImplicitJointDown).
 */
export function onImplicitCornerDown(e: MouseEvent, wire: CircuitWire, insertAt: number, pos: Point): void {
  e.stopPropagation();
  if (e.shiftKey) return; // not a real waypoint yet — nothing to delete
  const pt = clientToContent(e);
  state.draggingWaypoint = {
    wire,
    idx: insertAt,
    dx: pt.x - pos.x,
    dy: pt.y - pos.y,
    moved: false,
    pre: snapshot(),
    pendingInsert: { at: insertAt, point: { x: pos.x, y: pos.y } },
  };
}

/**
 * Mousedown on a ghost joint of a no-waypoint wire. We don't commit the
 * implicit joints into wire.waypoints up front — that would dirty the doc on
 * every selection click. Instead we stage them on the drag state and apply
 * on the first real mousemove.
 */
export function onImplicitJointDown(e: MouseEvent, wire: CircuitWire, idx: number, joints: Point[]): void {
  e.stopPropagation();
  if (e.shiftKey) return;
  const wp = joints[idx];
  if (!wp) return;
  const pt = clientToContent(e);
  state.draggingWaypoint = {
    wire, idx,
    dx: pt.x - wp.x, dy: pt.y - wp.y,
    moved: false, pre: snapshot(),
    pendingMaterialize: joints.map((j) => ({ x: j.x, y: j.y })),
  };
}
