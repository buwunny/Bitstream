/**
 * circuit-hdl.ts
 * ----------------------------------------------------------------------------
 * HDL emit for circuit documents. Generates Verilog, SystemVerilog, or VHDL
 * from a CircuitDoc, walking the module tree so the output is self-contained.
 * Mismatched-language HDL imports are returned in `skipped` so the caller can
 * warn the user.
 */

import { CircuitDoc, CircuitNode, HdlLanguage } from "./circuit-types";
import { portFromLabel, sanitize } from "./circuit-modules";

export interface HdlGenerateResult {
  text: string;
  /** Modules whose snapshotted HDL source was not inlined because it's a
   *  different language than the export target. Instances still appear in
   *  the output; the user must add the source via their toolchain. */
  skipped: Array<{ name: string; language: HdlLanguage }>;
}

function widthDecl(width: number): string {
  return width > 1 ? `[${width - 1}:0] ` : "";
}

/**
 * Walk the module tree gathering every distinct module body keyed by
 * sanitized name. First-write-wins, so two trees with the same module
 * name keep the first body encountered — emit conflicts are surfaced
 * to the user separately by the caller if needed.
 *
 * HDL-imported modules (those with `hdlSource`) are collected into
 * `hdlSources` when they're language-compatible with the export target.
 * Mismatched-language imports go into `skipped` so the caller can warn —
 * the instance still gets emitted but the user must supply the source
 * file separately through the toolchain. Verilog and SystemVerilog are
 * treated as mutually compatible for inlining; VHDL is its own bucket.
 */
function collectModuleArtifacts(
  doc: CircuitDoc,
  bodies: Map<string, CircuitDoc>,
  hdlSources: Map<string, string>,
  skipped: Array<{ name: string; language: HdlLanguage }>,
  target: HdlLanguage,
): void {
  for (const [name, m] of Object.entries(doc.modules ?? {})) {
    const key = sanitize(name);
    if (m.hdlSource) {
      const lang: HdlLanguage = m.language ?? "verilog";
      const compatible = target === "vhdl" ? lang === "vhdl" : lang !== "vhdl";
      if (compatible) {
        if (!hdlSources.has(key) && !bodies.has(key)) { hdlSources.set(key, m.hdlSource); }
      } else if (!skipped.some((s) => s.name === name)) {
        skipped.push({ name, language: lang });
      }
      continue;
    }
    if (bodies.has(key) || !m.body) { continue; }
    bodies.set(key, m.body);
    collectModuleArtifacts(m.body, bodies, hdlSources, skipped, target);
  }
}

/**
 * Emit HDL for the top doc plus every transitively referenced module body
 * in the requested target language. Each synthesised module is emitted
 * once (deduped by sanitized name); the top module comes last so
 * dependents appear before their references.
 */
export function generateHdl(doc: CircuitDoc, target: HdlLanguage): HdlGenerateResult {
  const bodies = new Map<string, CircuitDoc>();
  const hdlSources = new Map<string, string>();
  const skipped: Array<{ name: string; language: HdlLanguage }> = [];
  collectModuleArtifacts(doc, bodies, hdlSources, skipped, target);

  const parts: string[] = [];
  for (const src of hdlSources.values()) { parts.push(src.trimEnd() + "\n"); }
  if (target === "vhdl") {
    for (const body of bodies.values()) { parts.push(emitVhdlEntity(body)); }
    parts.push(emitVhdlEntity(doc));
  } else {
    const useLogic = target === "systemverilog";
    for (const body of bodies.values()) { parts.push(emitVerilogModule(body, useLogic)); }
    parts.push(emitVerilogModule(doc, useLogic));
  }
  return { text: parts.join("\n"), skipped };
}

/** Backwards-compatible Verilog-only entry point. */
export function generateVerilog(doc: CircuitDoc): string {
  return generateHdl(doc, "verilog").text;
}

/**
 * Emit a single module in Verilog or SystemVerilog. SV swaps `wire`/`reg`
 * for `logic` throughout — the synthesis semantics are otherwise identical
 * for what this editor generates.
 */
function emitVerilogModule(doc: CircuitDoc, useLogic: boolean): string {
  const netKw = useLogic ? "logic" : "wire";
  const regKw = useLogic ? "logic" : "reg ";
  const portKw = useLogic ? "logic" : "wire";
  const moduleName = sanitize(doc.moduleName || "circuit");
  const modules = doc.modules ?? {};

  const inputs = doc.nodes.filter((n) => n.type === "INPUT");
  const outputs = doc.nodes.filter((n) => n.type === "OUTPUT");
  const internals = doc.nodes.filter((n) => n.type !== "INPUT" && n.type !== "OUTPUT");

  // For each (sinkId, pinIdx) record the driving net name.
  const driverOf = new Map<string, string>();
  for (const w of doc.wires) {
    const src = doc.nodes.find((n) => n.id === w.from.id);
    if (!src) { continue; }
    let net: string;
    if (src.type === "INPUT") {
      net = portFromLabel(src.label).label;
    } else if (src.type === "MODULE" && src.moduleRef && modules[src.moduleRef]) {
      // Each module instance gets one wire per output pin.
      net = `n_${sanitize(src.id)}_o${w.from.pin}`;
    } else {
      net = `n_${sanitize(src.id)}`;
    }
    driverOf.set(`${w.to.id}:${w.to.pin}`, net);
  }
  const sinkOf = (nodeId: string, pin: number, width = 1): string =>
    driverOf.get(`${nodeId}:${pin}`) ?? (width > 1 ? `${width}'d0` : `1'b0`);

  // Port list.
  const inPorts = inputs.map((n) => portFromLabel(n.label));
  const outPorts = outputs.map((n) => portFromLabel(n.label));
  const portList = [...inPorts, ...outPorts].map((p) => p.label);

  const out: string[] = [];
  out.push(`// Auto-generated by Bitstream Circuit Editor.`);
  out.push(`module ${moduleName} (${portList.join(", ")});`);
  for (const p of inPorts) { out.push(`    input  ${portKw} ${widthDecl(p.width)}${p.label};`); }
  for (const p of outPorts) { out.push(`    output ${portKw} ${widthDecl(p.width)}${p.label};`); }
  out.push(``);

  // Declare internal nets. DFFs become regs (or logic in SV); module
  // instances expose one wire per output pin with the module's declared width.
  for (const n of internals) {
    if (n.type === "DFF") {
      out.push(`    ${regKw} n_${sanitize(n.id)};`);
    } else if (n.type === "MODULE") {
      const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
      if (!iface) { continue; }
      iface.outs.forEach((p, i) => {
        out.push(`    ${netKw} ${widthDecl(p.width)}n_${sanitize(n.id)}_o${i};`);
      });
    } else {
      out.push(`    ${netKw} n_${sanitize(n.id)};`);
    }
  }
  out.push(``);

  // Combinational + sequential + module instances.
  const binop = (op: string, n: CircuitNode, invert = false) => {
    const expr = `${sinkOf(n.id, 0)} ${op} ${sinkOf(n.id, 1)}`;
    out.push(`    assign n_${sanitize(n.id)} = ${invert ? `~(${expr})` : expr};`);
  };
  for (const n of internals) {
    switch (n.type) {
      case "AND": binop("&", n); break;
      case "OR": binop("|", n); break;
      case "XOR": binop("^", n); break;
      case "NAND": binop("&", n, true); break;
      case "NOR": binop("|", n, true); break;
      case "XNOR": binop("^", n, true); break;
      case "NOT": out.push(`    assign n_${sanitize(n.id)} = ~${sinkOf(n.id, 0)};`); break;
      case "BUF": out.push(`    assign n_${sanitize(n.id)} =  ${sinkOf(n.id, 0)};`); break;
      case "DFF":  /* below */ break;
      case "MODULE": {
        const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
        if (!iface || !n.moduleRef) { break; }
        const inst = `inst_${sanitize(n.id)}`;
        const connections: string[] = [];
        iface.ins.forEach((p, i) => {
          connections.push(`.${p.label}(${sinkOf(n.id, i, p.width)})`);
        });
        iface.outs.forEach((p, i) => {
          connections.push(`.${p.label}(n_${sanitize(n.id)}_o${i})`);
        });
        out.push(``);
        out.push(`    ${sanitize(n.moduleRef)} ${inst} (`);
        out.push(connections.map((c) => `        ${c}`).join(",\n"));
        out.push(`    );`);
        break;
      }
    }
  }

  const dffs = internals.filter((n) => n.type === "DFF");
  if (dffs.length) {
    out.push(``);
    for (const n of dffs) {
      const d = sinkOf(n.id, 0), clk = sinkOf(n.id, 1);
      out.push(`    always @(posedge ${clk}) n_${sanitize(n.id)} <= ${d};`);
    }
  }

  if (outputs.length) {
    out.push(``);
    for (const o of outputs) {
      const p = portFromLabel(o.label);
      out.push(`    assign ${p.label} = ${sinkOf(o.id, 0, p.width)};`);
    }
  }
  out.push(`endmodule`);
  out.push(``);
  return out.join("\n");
}

/**
 * Emit a single circuit as a VHDL entity + rtl architecture. Multi-bit ports
 * become `std_logic_vector`; 1-bit ports stay `std_logic`. Internal gate
 * nets are always 1-bit `std_logic`. Module instances use VHDL '93 direct
 * entity instantiation (`entity work.<name>`) so no separate component
 * declarations are needed.
 */
function emitVhdlEntity(doc: CircuitDoc): string {
  const moduleName = sanitize(doc.moduleName || "circuit");
  const modules = doc.modules ?? {};

  const inputs = doc.nodes.filter((n) => n.type === "INPUT");
  const outputs = doc.nodes.filter((n) => n.type === "OUTPUT");
  const internals = doc.nodes.filter((n) => n.type !== "INPUT" && n.type !== "OUTPUT");

  const driverOf = new Map<string, string>();
  for (const w of doc.wires) {
    const src = doc.nodes.find((n) => n.id === w.from.id);
    if (!src) { continue; }
    let net: string;
    if (src.type === "INPUT") {
      net = portFromLabel(src.label).label;
    } else if (src.type === "MODULE" && src.moduleRef && modules[src.moduleRef]) {
      net = `n_${sanitize(src.id)}_o${w.from.pin}`;
    } else {
      net = `n_${sanitize(src.id)}`;
    }
    driverOf.set(`${w.to.id}:${w.to.pin}`, net);
  }
  const sinkOf = (nodeId: string, pin: number, width = 1): string =>
    driverOf.get(`${nodeId}:${pin}`) ?? (width > 1 ? `(others => '0')` : `'0'`);

  const vhdlType = (w: number): string =>
    w > 1 ? `std_logic_vector(${w - 1} downto 0)` : `std_logic`;

  const inPorts = inputs.map((n) => portFromLabel(n.label));
  const outPorts = outputs.map((n) => portFromLabel(n.label));

  const out: string[] = [];
  out.push(`-- Auto-generated by Bitstream Circuit Editor.`);
  out.push(`library ieee;`);
  out.push(`use ieee.std_logic_1164.all;`);
  out.push(``);
  out.push(`entity ${moduleName} is`);
  if (inPorts.length || outPorts.length) {
    const portLines: string[] = [];
    for (const p of inPorts) { portLines.push(`        ${p.label} : in  ${vhdlType(p.width)}`); }
    for (const p of outPorts) { portLines.push(`        ${p.label} : out ${vhdlType(p.width)}`); }
    out.push(`    port (`);
    out.push(portLines.join(";\n"));
    out.push(`    );`);
  }
  out.push(`end entity ${moduleName};`);
  out.push(``);
  out.push(`architecture rtl of ${moduleName} is`);

  for (const n of internals) {
    if (n.type === "MODULE") {
      const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
      if (!iface) { continue; }
      iface.outs.forEach((p, i) => {
        out.push(`    signal n_${sanitize(n.id)}_o${i} : ${vhdlType(p.width)};`);
      });
    } else {
      // Gates and DFFs alike: 1-bit std_logic net carrying the gate result.
      out.push(`    signal n_${sanitize(n.id)} : std_logic;`);
    }
  }
  out.push(`begin`);

  const binop = (op: string, n: CircuitNode) => {
    out.push(`    n_${sanitize(n.id)} <= ${sinkOf(n.id, 0)} ${op} ${sinkOf(n.id, 1)};`);
  };
  for (const n of internals) {
    switch (n.type) {
      case "AND": binop("and", n); break;
      case "OR": binop("or", n); break;
      case "XOR": binop("xor", n); break;
      case "NAND": binop("nand", n); break;
      case "NOR": binop("nor", n); break;
      case "XNOR": binop("xnor", n); break;
      case "NOT": out.push(`    n_${sanitize(n.id)} <= not ${sinkOf(n.id, 0)};`); break;
      case "BUF": out.push(`    n_${sanitize(n.id)} <=     ${sinkOf(n.id, 0)};`); break;
      case "DFF": {
        const d = sinkOf(n.id, 0), clk = sinkOf(n.id, 1);
        out.push(``);
        out.push(`    process(${clk})`);
        out.push(`    begin`);
        out.push(`        if rising_edge(${clk}) then`);
        out.push(`            n_${sanitize(n.id)} <= ${d};`);
        out.push(`        end if;`);
        out.push(`    end process;`);
        break;
      }
      case "MODULE": {
        const iface = n.moduleRef ? modules[n.moduleRef] : undefined;
        if (!iface || !n.moduleRef) { break; }
        const inst = `inst_${sanitize(n.id)}`;
        const conns: string[] = [];
        iface.ins.forEach((p, i) => {
          conns.push(`            ${p.label} => ${sinkOf(n.id, i, p.width)}`);
        });
        iface.outs.forEach((p, i) => {
          conns.push(`            ${p.label} => n_${sanitize(n.id)}_o${i}`);
        });
        out.push(``);
        out.push(`    ${inst} : entity work.${sanitize(n.moduleRef)}`);
        out.push(`        port map (`);
        out.push(conns.join(",\n"));
        out.push(`        );`);
        break;
      }
    }
  }

  if (outputs.length) {
    out.push(``);
    for (const o of outputs) {
      const p = portFromLabel(o.label);
      out.push(`    ${p.label} <= ${sinkOf(o.id, 0, p.width)};`);
    }
  }
  out.push(`end architecture rtl;`);
  out.push(``);
  return out.join("\n");
}
