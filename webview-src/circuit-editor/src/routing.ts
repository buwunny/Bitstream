// Wire routing math: bezier for curved mode, polyline + Manhattan corners for
// straight/right-angle, plus the helpers that let users grab implicit corners
// and promote them into real waypoints.

import { pinPos } from "./shapes";
import { pushHistory, state } from "./state";
import { setDirty } from "./dirty";
import type { CircuitWire, Point } from "./types";

export function bezier(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/**
 * Build the SVG path 'd' attribute for a wire. Curved uses a single bezier;
 * straight draws a polyline through every waypoint (or a default L-route);
 * manhattan is straight + a guarantee that every segment is axis-aligned.
 */
export function wirePath(a: Point, b: Point, wire?: CircuitWire): string {
  const style = state.doc.routingStyle ?? "curved";
  if (style === "curved") return bezier(a, b);
  const wps = wire?.waypoints ?? [];
  if (style === "manhattan") return manhattanPath(a, b, wps);
  if (!wps.length) {
    // Default Manhattan-style Z route: out → mid-x at a.y → mid-x at b.y → in.
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
  }
  const parts: string[] = [`M ${a.x} ${a.y}`];
  for (const wp of wps) parts.push(`L ${wp.x} ${wp.y}`);
  parts.push(`L ${b.x} ${b.y}`);
  return parts.join(" ");
}

/**
 * Manhattan route through (a, ...wps, b). Pins are on the left/right of nodes
 * so the first and last segments must leave/enter horizontally — we achieve
 * that by H-first L-routes everywhere except the final segment, which is
 * V-first so it lands H into the destination pin. Already-aligned segments
 * skip the corner. Empty-waypoint case uses a Z-route (H-V-H).
 */
export function manhattanPath(a: Point, b: Point, wps: Point[]): string {
  if (!wps.length) {
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
  }
  const pts: Point[] = [a, ...wps, b];
  const parts: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    if (p.x === q.x || p.y === q.y) {
      parts.push(`L ${q.x} ${q.y}`);
      continue;
    }
    const isLast = i === pts.length - 2;
    const corner = isLast ? { x: p.x, y: q.y } : { x: q.x, y: p.y };
    parts.push(`L ${corner.x} ${corner.y}`);
    parts.push(`L ${q.x} ${q.y}`);
  }
  return parts.join(" ");
}

/**
 * Implicit L-corner positions inserted by manhattanPath for the given
 * (a, ...wps, b) sequence. Each entry carries the wps-index where the corner
 * should be spliced in if the user grabs and drags it.
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

/** The two implicit corners of the default Z-route between pins a and b. */
export function defaultZJoints(a: Point, b: Point): [Point, Point] {
  const mx = (a.x + b.x) / 2;
  return [{ x: mx, y: a.y }, { x: mx, y: b.y }];
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
 * Insert a new routing waypoint at `pt` into wire `w`. The insertion index is
 * chosen so the click point lands on the polyline segment it's closest to,
 * which keeps the wire visually unchanged at the moment of insert.
 */
export function insertWaypoint(w: CircuitWire, pt: Point): void {
  const src = state.doc.nodes.find((n) => n.id === w.from.id);
  const dst = state.doc.nodes.find((n) => n.id === w.to.id);
  if (!src || !dst) return;
  const a = pinPos(src, w.from.side, w.from.pin);
  const b = pinPos(dst, w.to.side, w.to.pin);
  const wps: Point[] = (w.waypoints ?? []).slice();
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
