// Wire routing math: bezier for curved mode, polyline + Manhattan corners for
// straight/right-angle, plus the helpers that let users grab implicit corners
// and promote them into real waypoints. Default routes avoid the source and
// destination node bodies so self-loops and back-routes don't run through
// their own gates.

import { pinPos, pinWidth, shapeOf } from "./shapes";
import { GRID, pushHistory, state } from "./state";
import { setDirty } from "./dirty";
import type { CircuitNode, CircuitWire, Point } from "./types";

/** Clearance around node bodies when building default routes. */
const PAD = GRID;

function nodeBounds(n: CircuitNode): { x: number; y: number; w: number; h: number } {
  const s = shapeOf(n);
  return { x: n.x, y: n.y, w: s.w, h: s.h };
}

export function bezier(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/**
 * Polyline used when a wire has no explicit waypoints. Plain Z-route when the
 * sink sits clear to the right of the source; otherwise (self-loops, or sinks
 * left of source) a U-route around the source/destination bodies so the wire
 * never passes through a gate it's attached to.
 */
export function defaultRoute(a: Point, b: Point, src: CircuitNode, dst: CircuitNode): Point[] {
  const sb = nodeBounds(src);
  const db = nodeBounds(dst);
  const needsLoop = src.id === dst.id || b.x <= a.x + 2 * PAD;
  if (!needsLoop) {
    let mx = Math.round((a.x + b.x) / 2);
    if (mx <= sb.x + sb.w) mx = sb.x + sb.w + PAD;
    if (mx >= db.x) mx = db.x - PAD;
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  const topY = Math.min(sb.y, db.y) - PAD;
  const botY = Math.max(sb.y + sb.h, db.y + db.h) + PAD;
  const avgY = (a.y + b.y) / 2;
  const yClear = (avgY - topY) <= (botY - avgY) ? topY : botY;
  const rightX = Math.max(sb.x + sb.w, a.x) + PAD;
  const leftX = Math.min(db.x, b.x) - PAD;
  return [
    a,
    { x: rightX, y: a.y },
    { x: rightX, y: yClear },
    { x: leftX, y: yClear },
    { x: leftX, y: b.y },
    b,
  ];
}

/**
 * Vertices of a wire's rendered polyline — endpoints, explicit waypoints,
 * and (for manhattan) implicit L-corners. Used by both wirePath and the
 * junction detector so they see the same path.
 */
export function wireVertices(w: CircuitWire): Point[] {
  const src = state.doc.nodes.find((n) => n.id === w.from.id);
  const dst = state.doc.nodes.find((n) => n.id === w.to.id);
  if (!src || !dst) return [];
  const a = pinPos(src, w.from.side, w.from.pin);
  const b = pinPos(dst, w.to.side, w.to.pin);
  const style = state.doc.routingStyle ?? "curved";
  if (style === "curved") return [a, b];
  const wps = w.waypoints ?? [];
  if (!wps.length) return defaultRoute(a, b, src, dst);
  if (style === "manhattan") return expandManhattanVerts(a, b, wps);
  return [a, ...wps, b];
}

function expandManhattanVerts(a: Point, b: Point, wps: Point[]): Point[] {
  const pts: Point[] = [a, ...wps, b];
  const out: Point[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    if (p.x === q.x || p.y === q.y) { out.push(q); continue; }
    const isLast = i === pts.length - 2;
    const corner = isLast ? { x: p.x, y: q.y } : { x: q.x, y: p.y };
    out.push(corner);
    out.push(q);
  }
  return out;
}

/**
 * Build the SVG path 'd' attribute for a wire. Curved is a single bezier;
 * everything else is a polyline through wireVertices(wire).
 */
export function wirePath(a: Point, b: Point, wire?: CircuitWire): string {
  const style = state.doc.routingStyle ?? "curved";
  if (style === "curved") return bezier(a, b);
  if (!wire) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const verts = wireVertices(wire);
  if (verts.length < 2) return "";
  const parts: string[] = [`M ${verts[0].x} ${verts[0].y}`];
  for (let i = 1; i < verts.length; i++) parts.push(`L ${verts[i].x} ${verts[i].y}`);
  return parts.join(" ");
}

/**
 * Implicit L-corner positions inserted between explicit waypoints in
 * manhattan mode. Each entry's `insertAt` is the wps-index for splice if the
 * user grabs and drags it.
 */
export function manhattanGhostCorners(
  a: Point, b: Point, wps: Point[],
): { pos: Point; insertAt: number }[] {
  const pts: Point[] = [a, ...wps, b];
  const out: { pos: Point; insertAt: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    if (p.x === q.x || p.y === q.y) continue;
    const isLast = i === pts.length - 2;
    const pos = isLast ? { x: p.x, y: q.y } : { x: q.x, y: p.y };
    out.push({ pos, insertAt: i });
  }
  return out;
}

/**
 * Interior vertices of a wire's default route — exposed as ghost handles on
 * selected wires that have no waypoints yet. Dragging any of them
 * materializes the full route into wire.waypoints.
 */
export function defaultRouteJoints(w: CircuitWire): Point[] {
  const src = state.doc.nodes.find((n) => n.id === w.from.id);
  const dst = state.doc.nodes.find((n) => n.id === w.to.id);
  if (!src || !dst) return [];
  const a = pinPos(src, w.from.side, w.from.pin);
  const b = pinPos(dst, w.to.side, w.to.pin);
  return defaultRoute(a, b, src, dst).slice(1, -1);
}

/** Distance from a point to the line segment a-b. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Project `pt` onto a wire's polyline. Returns the projected point and the
 * waypoint prefix that, combined with the projected point, traces the
 * existing wire from its source up to the tap. Used by the shift+click
 * tap-into-net gesture so the new wire literally shares the existing trunk.
 */
export function tapPointOnWire(
  w: CircuitWire,
  pt: Point,
): { tap: Point; prefix: Point[] } | null {
  const verts = wireVertices(w);
  if (verts.length < 2) return null;
  let segIdx = 0;
  let bestDist = Infinity;
  let bestT = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d = Math.hypot(pt.x - px, pt.y - py);
    if (d < bestDist) { bestDist = d; segIdx = i; bestT = t; }
  }
  const a = verts[segIdx], b = verts[segIdx + 1];
  const tap: Point = { x: a.x + bestT * (b.x - a.x), y: a.y + bestT * (b.y - a.y) };
  // Prefix is verts[1..segIdx] — skip verts[0] (the source pin, supplied via
  // from) and verts[verts.length-1] (the destination pin of the tapped wire).
  const prefix: Point[] = [];
  for (let i = 1; i <= segIdx; i++) prefix.push({ x: verts[i].x, y: verts[i].y });
  return { tap, prefix };
}

/**
 * Insert a new routing waypoint at `pt` into wire `w` at the polyline segment
 * it's closest to. If the wire has no waypoints, the default route is
 * materialized first so the visual path doesn't snap to a different shape.
 */
export function insertWaypoint(w: CircuitWire, pt: Point): void {
  const src = state.doc.nodes.find((n) => n.id === w.from.id);
  const dst = state.doc.nodes.find((n) => n.id === w.to.id);
  if (!src || !dst) return;
  const a = pinPos(src, w.from.side, w.from.pin);
  const b = pinPos(dst, w.to.side, w.to.pin);
  let wps: Point[] = (w.waypoints ?? []).slice();
  if (!wps.length) {
    const verts = defaultRoute(a, b, src, dst);
    wps = verts.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
  }
  const pts: Point[] = [a, ...wps, b];
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(pt, pts[i], pts[i + 1]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  pushHistory();
  wps.splice(bestIdx, 0, { x: pt.x, y: pt.y });
  w.waypoints = wps;
  setDirty(true);
}

function colinear(p: Point, q: Point, r: Point): boolean {
  return (q.x - p.x) * (r.y - p.y) === (q.y - p.y) * (r.x - p.x);
}

/**
 * Remove waypoints that lie on the straight segment between their neighbors
 * and dedupe consecutive identicals. Called whenever wire geometry changes so
 * a user-drag that flattens a corner doesn't leave a useless joint behind.
 * Manhattan mode is skipped — its renderer inserts orthogonal corners
 * between waypoints, so colinear-looking sequences are still load-bearing.
 */
export function simplifyWaypoints(w: CircuitWire): void {
  if (!w.waypoints || !w.waypoints.length) return;
  if ((state.doc.routingStyle ?? "curved") === "manhattan") return;
  const src = state.doc.nodes.find((n) => n.id === w.from.id);
  const dst = state.doc.nodes.find((n) => n.id === w.to.id);
  if (!src || !dst) return;
  const a = pinPos(src, w.from.side, w.from.pin);
  const b = pinPos(dst, w.to.side, w.to.pin);
  const all: Point[] = [a, ...w.waypoints, b];
  const kept: Point[] = [];
  let last: Point = a;
  for (let i = 1; i < all.length - 1; i++) {
    const cur = all[i];
    const next = all[i + 1];
    if (cur.x === last.x && cur.y === last.y) continue;
    if (cur.x === next.x && cur.y === next.y) continue;
    if (colinear(last, cur, next)) continue;
    kept.push({ x: cur.x, y: cur.y });
    last = cur;
  }
  w.waypoints = kept.length ? kept : undefined;
}

/**
 * Points where a junction dot should be drawn — anywhere 3+ wire branches
 * converge. Each pin contributes 1 branch (its gate stub); a wire endpoint
 * contributes 1 branch; a wire's interior waypoint contributes 2 (one for
 * each adjacent segment). So a Y-fanout at a pin is 3 (pin + 2 wires), a
 * T-tap is 3 (wire-end + pass-through), an X is 4, and a single-wire bend
 * is 2 (no dot).
 */
export function junctionPoints(): { p: Point; busWidth: number }[] {
  const branches = new Map<string, number>();
  const points = new Map<string, Point>();
  const widthAt = new Map<string, number>();
  const k = (p: Point) => `${p.x}:${p.y}`;
  const bump = (p: Point, inc: number, width: number) => {
    const key = k(p);
    branches.set(key, (branches.get(key) ?? 0) + inc);
    if (!points.has(key)) points.set(key, p);
    if ((widthAt.get(key) ?? 0) < width) widthAt.set(key, width);
  };

  for (const n of state.doc.nodes) {
    const s = shapeOf(n);
    for (let i = 0; i < s.ins.length; i++) bump(pinPos(n, "in", i), 1, 1);
    for (let i = 0; i < s.outs.length; i++) bump(pinPos(n, "out", i), 1, 1);
  }

  for (const w of state.doc.wires) {
    const verts = wireVertices(w);
    if (verts.length < 2) continue;
    const src = state.doc.nodes.find((n) => n.id === w.from.id);
    const dst = state.doc.nodes.find((n) => n.id === w.to.id);
    if (!src || !dst) continue;
    // Wider of the two pin widths drives the junction dot size for buses.
    const ww = Math.max(pinWidth(src, "out", w.from.pin), pinWidth(dst, "in", w.to.pin));
    for (let i = 0; i < verts.length; i++) {
      const isEnd = i === 0 || i === verts.length - 1;
      bump(verts[i], isEnd ? 1 : 2, ww);
    }
  }

  const out: { p: Point; busWidth: number }[] = [];
  for (const [key, count] of branches) {
    if (count < 3) continue;
    out.push({ p: points.get(key)!, busWidth: widthAt.get(key) ?? 1 });
  }
  return out;
}
