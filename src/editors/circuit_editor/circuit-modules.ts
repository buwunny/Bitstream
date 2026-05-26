/**
 * circuit-modules.ts
 * ----------------------------------------------------------------------------
 * Host-side helpers for working with module artefacts: identifier sanitising,
 * HDL file parsing, port-label parsing, and cycle detection between module
 * trees. Used both when importing modules and when emitting HDL.
 */

import * as fs from "fs";
import * as path from "path";
import { parseVerilogText, parseVhdlText, ModuleDecl } from "../../project/hierarchy";
import { CircuitDoc, HdlLanguage, ModulePort } from "./circuit-types";

/** Make an identifier safe to use as a Verilog/VHDL name. */
export function sanitize(s: string): string {
  return (s || "").replace(/[^A-Za-z0-9_]/g, "_") || "u";
}

/** Map a file extension to one of the supported HDL flavours. */
export function detectHdlLanguage(absPath: string): HdlLanguage {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".vhd" || ext === ".vhdl") { return "vhdl"; }
  if (ext === ".sv" || ext === ".svh") { return "systemverilog"; }
  return "verilog";
}

/**
 * Read an HDL file and dispatch to the right parser. Returns the module
 * declarations, the detected language, and the raw file contents (which the
 * caller snapshots into the circuit document so export stays self-contained).
 */
export function parseHdlFile(
  absPath: string,
  relPath: string,
): { decls: ModuleDecl[]; language: HdlLanguage; source: string } {
  const source = fs.readFileSync(absPath, "utf8");
  const language = detectHdlLanguage(absPath);
  const decls = language === "vhdl"
    ? parseVhdlText(source, relPath)
    : parseVerilogText(source, relPath);
  return { decls, language, source };
}

/** Parse a port label like `data[7:0]` into { label, width }. */
export function portFromLabel(label: string): ModulePort {
  const m = /^([A-Za-z_]\w*)\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*$/.exec((label || "").trim());
  if (m) {
    const hi = parseInt(m[2], 10), lo = parseInt(m[3], 10);
    return { label: m[1], width: Math.abs(hi - lo) + 1 };
  }
  const m2 = /^([A-Za-z_]\w*)\s*$/.exec((label || "").trim());
  return { label: m2 ? m2[1] : sanitize(label), width: 1 };
}

/** True if `doc` or any nested module body uses (sanitized) `targetName`. */
export function referencesModule(doc: CircuitDoc, targetName: string): boolean {
  if (sanitize(doc.moduleName) === targetName) { return true; }
  for (const m of Object.values(doc.modules ?? {})) {
    if (m.body && referencesModule(m.body, targetName)) { return true; }
  }
  return false;
}
