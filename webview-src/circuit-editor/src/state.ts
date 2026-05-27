// Singleton runtime state for the webview. Other modules read and mutate
// `state.*` directly — the JS source this module replaces was effectively one
// module already, so we don't try to enforce stricter access boundaries here.

import type {
  CircuitDoc,
  CircuitWire,
  ClipboardData,
  DragState,
  PanState,
  PendingWire,
  RoutingStyle,
  RubberBand,
  ViewTransform,
  WaypointDragState,
} from "./types";

export const HISTORY_LIMIT = 100;
/** Grid step in content units, matched to the visible 20px background grid. */
export const GRID = 10;
export const DEFAULT_PICKER_COLOR = "#6ab0f3";

export interface State {
  doc: CircuitDoc;
  nextId: number;
  selectedNodes: Set<string>;
  selectedWire: CircuitWire | null;
  /** Waypoints accumulate as the user clicks empty canvas while drawing in straight mode. */
  pendingWire: PendingWire | null;
  dragging: DragState | null;
  draggingWaypoint: WaypointDragState | null;
  panning: PanState | null;
  spaceHeld: boolean;
  rubber: RubberBand | null;
  view: ViewTransform;
  /** Past doc snapshots as JSON strings; small enough that diff-based history isn't worth it. */
  history: string[];
  future: string[];
  clipboard: ClipboardData | null;
  dirty: boolean;
  snapEnabled: boolean;
  _renderPending: boolean;
  _docSyncTimer: ReturnType<typeof setTimeout> | null;
}

export const state: State = {
  doc: { moduleName: "circuit", nodes: [], wires: [], modules: {}, routingStyle: "straight" },
  nextId: 1,
  selectedNodes: new Set(),
  selectedWire: null,
  pendingWire: null,
  dragging: null,
  draggingWaypoint: null,
  panning: null,
  spaceHeld: false,
  rubber: null,
  view: { tx: 0, ty: 0, scale: 1 },
  history: [],
  future: [],
  clipboard: null,
  dirty: false,
  snapEnabled: true,
  _renderPending: false,
  _docSyncTimer: null,
};

export function freshId(): string {
  return "n" + state.nextId++;
}

export function routingStyle(): RoutingStyle {
  return state.doc.routingStyle ?? "curved";
}

// Both straight and manhattan share the orthogonal interaction model: click
// to add waypoints, dblclick to insert, handles on selected wires. Curved
// opts out of all of that.
export function orthogonalMode(): boolean {
  const s = routingStyle();
  return s === "straight" || s === "manhattan";
}

export function snap(v: number): number {
  return state.snapEnabled ? Math.round(v / GRID) * GRID : v;
}

export function snapshot(): string {
  return JSON.stringify(state.doc);
}

// Lives here (and not in history.ts) because routing.ts and interaction.ts
// need to push snapshots from low-level code paths without dragging in the
// DOM-touching helpers that history.ts/undo/redo carry along.
export function pushHistory(): void {
  state.history.push(snapshot());
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.future.length = 0;
}

export function defaultLabel(type: string, moduleRef?: string): string {
  if (type === "MODULE" && moduleRef) {
    const same = state.doc.nodes.filter((n) => n.type === "MODULE" && n.moduleRef === moduleRef).length;
    return moduleRef + (same + 1);
  }
  const same = state.doc.nodes.filter((n) => n.type === type).length;
  if (type === "INPUT") return "in" + (same + 1);
  if (type === "OUTPUT") return "out" + (same + 1);
  return type.toLowerCase() + (same + 1);
}
