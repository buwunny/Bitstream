// Per-node geometry. All dimensions and pin offsets are multiples of GRID
// (20) so that — once a node is grid-aligned — every wire endpoint sits
// exactly on a grid intersection. SVG icons share viewBox 0 0 100 80 and
// stretch via preserveAspectRatio='none'; stubs in the SVGs land on these pin
// positions.

import { state } from "./state";
import type { CircuitNode, NodeShape, NodeType, PinSide, Point } from "./types";

type FixedShape = { w: number; h: number; ins: { y: number }[]; outs: { y: number }[] };

export const FIXED_SHAPES: Partial<Record<NodeType, FixedShape>> = {
  INPUT: { w: 60, h: 40, ins: [], outs: [{ y: 20 }] },
  OUTPUT: { w: 60, h: 40, ins: [{ y: 20 }], outs: [] },
  AND: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
  OR: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
  XOR: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
  NAND: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
  NOR: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
  XNOR: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
  NOT: { w: 60, h: 40, ins: [{ y: 20 }], outs: [{ y: 20 }] },
  BUF: { w: 60, h: 40, ins: [{ y: 20 }], outs: [{ y: 20 }] },
  DFF: { w: 80, h: 80, ins: [{ y: 20 }, { y: 60 }], outs: [{ y: 40 }] },
};

/**
 * MODULE instances size themselves from the imported interface so any port
 * count fits. Width, height, and pin y's are all GRID-aligned so wire endpoints
 * land on grid.
 */
export function shapeOf(node: CircuitNode): NodeShape {
  if (node.type !== "MODULE") {
    const fixed = FIXED_SHAPES[node.type];
    if (!fixed) throw new Error(`No fixed shape for ${node.type}`);
    return fixed;
  }
  const iface = (state.doc.modules ?? {})[node.moduleRef ?? ""] ?? { ins: [], outs: [] };
  const rows = Math.max(1, iface.ins.length, iface.outs.length);
  // Top offset 40 leaves room for the module-name label without overlapping
  // the first pin; +20 below the last pin matches the symmetric padding.
  const h = 60 + rows * 20;
  const ins = iface.ins.map((p, i) => ({ y: 40 + i * 20, lbl: p.label, width: p.width }));
  const outs = iface.outs.map((p, i) => ({ y: 40 + i * 20, lbl: p.label, width: p.width }));
  return { w: 120, h, ins, outs };
}

export function parseLabel(label: string | undefined): { name: string; width: number } {
  const m = /^([A-Za-z_]\w*)\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*$/.exec((label ?? "").trim());
  if (m) {
    const hi = parseInt(m[2], 10), lo = parseInt(m[3], 10);
    return { name: m[1], width: Math.abs(hi - lo) + 1 };
  }
  return { name: (label ?? "").trim(), width: 1 };
}

/** Width of a node's pin, used to render bus markers and pick wire styling. */
export function pinWidth(node: CircuitNode, side: PinSide, idx: number): number {
  const s = shapeOf(node);
  const p = side === "in" ? s.ins[idx] : s.outs[idx];
  if (p && p.width) return p.width;
  if (node.type === "INPUT" || node.type === "OUTPUT") return parseLabel(node.label).width;
  return 1;
}

export function pinPos(node: CircuitNode, side: PinSide, idx: number): Point {
  const s = shapeOf(node);
  const p = side === "in" ? s.ins[idx] : s.outs[idx];
  if (!p) return { x: node.x, y: node.y };
  return { x: node.x + (side === "in" ? 0 : s.w), y: node.y + p.y };
}
