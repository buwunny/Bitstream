// Re-export the document-model types from the extension-side definitions so
// the webview bundle stays bit-for-bit consistent with the host. Anything
// webview-specific (drag state, view transform, pending wire, etc.) is kept
// in state.ts.

export type {
  CircuitDoc,
  CircuitNode,
  CircuitWire,
  HdlLanguage,
  ModuleInterface,
  ModulePort,
  NodeType,
  PinSide,
  RoutingStyle,
} from "../../../src/editors/circuit_editor/circuit-types";

/** Endpoint reference used by CircuitWire.from / .to. */
export interface PinRef {
  id: string;
  pin: number;
  side: "in" | "out";
}

/** A pin definition produced by shapeOf — geometry + optional bus metadata. */
export interface PinSpec {
  y: number;
  lbl?: string;
  width?: number;
}

/** Resolved geometry for a node — fed into render and hit-testing. */
export interface NodeShape {
  w: number;
  h: number;
  ins: PinSpec[];
  outs: PinSpec[];
}

export interface Point {
  x: number;
  y: number;
}

/** In-flight wire draw — accumulated waypoints, live cursor position. */
export interface PendingWire {
  from: PinRef;
  mouse: Point;
  waypoints: Point[];
}

/** Active node-drag state: per-node grab offsets + commit-on-move snapshot. */
export interface DragState {
  offsets: Map<string, { dx: number; dy: number }>;
  moved: boolean;
  pre: string;
}

/** Active waypoint-drag, including staged promotions for ghost handles. */
export interface WaypointDragState {
  wire: import("./types").CircuitWire;
  idx: number;
  dx: number;
  dy: number;
  moved: boolean;
  pre: string;
  pendingMaterialize?: Point[];
  pendingInsert?: { at: number; point: Point };
}

export interface PanState {
  startX: number;
  startY: number;
  startTx: number;
  startTy: number;
}

export interface RubberBand {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ViewTransform {
  tx: number;
  ty: number;
  scale: number;
}

export interface ClipboardData {
  nodes: import("./types").CircuitNode[];
  wires: import("./types").CircuitWire[];
}

/** Gate-type → SVG webview URI map. Injected by the host as window.GATE_URIS. */
export type GateUriMap = Partial<Record<import("./types").NodeType, string>> &
  Record<string, string | undefined>;

declare global {
  interface Window {
    GATE_URIS?: GateUriMap;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

/** Slim shape of the API returned by acquireVsCodeApi(). */
export interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState?: <T = unknown>() => T | undefined;
  setState?: <T = unknown>(state: T) => void;
}
