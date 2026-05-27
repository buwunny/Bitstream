// View transform: pan/zoom math, content↔client coordinate conversions, and
// the snap-to-grid helper used everywhere a user drag lands a point.

import { svg, viewport, zoomLabel } from "./dom";
import { snap, state } from "./state";
import type { Point } from "./types";

export function clientToContent(e: { clientX: number; clientY: number }): Point {
  const rect = svg.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - state.view.tx) / state.view.scale,
    y: (e.clientY - rect.top - state.view.ty) / state.view.scale,
  };
}

export function applyView(): void {
  viewport.setAttribute(
    "transform",
    `translate(${state.view.tx},${state.view.ty}) scale(${state.view.scale})`,
  );
  zoomLabel.textContent = `${Math.round(state.view.scale * 100)}%`;
}

export function snapPt(p: Point): Point {
  return { x: snap(p.x), y: snap(p.y) };
}

/** Which content-space rect is currently visible? Inverse of the transform. */
export function visibleRect(): { x: number; y: number; w: number; h: number } {
  const rect = svg.getBoundingClientRect();
  return {
    x: -state.view.tx / state.view.scale,
    y: -state.view.ty / state.view.scale,
    w: rect.width / state.view.scale,
    h: rect.height / state.view.scale,
  };
}

export function rectIntersects(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return !(ax + aw < bx || bx + bw < ax || ay + ah < by || by + bh < ay);
}
