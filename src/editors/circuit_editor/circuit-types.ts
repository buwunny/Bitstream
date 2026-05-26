/**
 * circuit-types.ts
 * ----------------------------------------------------------------------------
 * Pure type declarations for the circuit editor document model. Kept free of
 * runtime imports so it can be referenced by host, emit, and webview code.
 */

export type PinSide = "in" | "out";

export type NodeType =
  | "INPUT" | "OUTPUT"
  | "AND" | "OR" | "XOR" | "NAND" | "NOR" | "XNOR"
  | "NOT" | "BUF"
  | "DFF"
  | "MODULE";

export interface ModulePort { label: string; width: number; }

/** HDL flavour for imports and exports. */
export type HdlLanguage = "verilog" | "systemverilog" | "vhdl";

export interface ModuleInterface {
  ins: ModulePort[];
  outs: ModulePort[];
  /** Relative path the module was imported from — kept for drill-down and reload. */
  file?: string;
  /**
   * Full body of the referenced design. We snapshot it at import time so the
   * file is self-contained: Verilog export can emit the whole hierarchy
   * without re-reading anything from disk, and offline editing keeps
   * working. A separate "Reload Modules" action picks up external changes.
   */
  body?: CircuitDoc;
  /**
   * Raw HDL source for imported leaf modules. When set the module is a leaf
   * — export emits this text verbatim instead of synthesising from `body`.
   * `language` tags the source flavour so cross-language exports can decide
   * to inline (matching language) or skip (mismatched) on a per-import basis.
   */
  hdlSource?: string;
  language?: HdlLanguage;
}

export interface CircuitNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  label: string;
  /** Present when type === "MODULE" — key into doc.modules. */
  moduleRef?: string;
  /** Optional CSS color string overriding the default node fill/outline. */
  color?: string;
}

export interface CircuitWire {
  from: { id: string; pin: number; side: PinSide };
  to: { id: string; pin: number; side: PinSide };
  /** Optional CSS color string overriding the default wire stroke. */
  color?: string;
  /**
   * Intermediate routing points for straight-wire layout. Each point is in
   * content-space coordinates and becomes a vertex in the polyline drawn
   * from `from` through the waypoints to `to`. Ignored in curved mode.
   */
  waypoints?: Array<{ x: number; y: number }>;
}

/**
 * Wire layout mode:
 *   • curved    — single bezier per wire, no waypoints.
 *   • straight  — polyline through waypoints; segments can be any angle.
 *   • manhattan — polyline through waypoints, but every rendered segment is
 *                 forced to be axis-aligned (right angles only).
 */
export type RoutingStyle = "curved" | "straight" | "manhattan";

export interface CircuitDoc {
  moduleName: string;
  nodes: CircuitNode[];
  wires: CircuitWire[];
  /** Hierarchical module library kept inline so the file is self-contained. */
  modules?: Record<string, ModuleInterface>;
  /** Wire rendering mode. Defaults to "curved" when absent. */
  routingStyle?: RoutingStyle;
}

export const FILE_EXT = ".bscircuit.json";
