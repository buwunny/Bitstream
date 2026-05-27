// Palette: built-in components, dynamic module list, drag/drop onto canvas,
// and persistence of the per-section collapsed state.

import { setDirty } from "./dirty";
import { moduleListEl, svg } from "./dom";
import { render } from "./render";
import { syncColorPickerToSelection } from "./selection";
import { FIXED_SHAPES, shapeOf } from "./shapes";
import { defaultLabel, freshId, pushHistory, snap, state } from "./state";
import { clientToContent } from "./view";
import { vscode } from "./vscode-api";
import type { CircuitNode, NodeType } from "./types";

export function attachPaletteDrag(el: HTMLElement): void {
  el.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("text/bitstream-node", el.dataset.type ?? "");
    if (el.dataset.module) e.dataTransfer.setData("text/bitstream-module", el.dataset.module);
    e.dataTransfer.effectAllowed = "copy";
  });
}

export function rebuildModulePalette(): void {
  moduleListEl.innerHTML = "";
  const modules = state.doc.modules ?? {};
  for (const name of Object.keys(modules).sort()) {
    const item = document.createElement("div");
    item.className = "item";
    item.draggable = true;
    item.dataset.type = "MODULE";
    item.dataset.module = name;
    const iface = modules[name];
    item.innerHTML = `<span>${name}</span><span class="badge">${iface.ins.length} in / ${iface.outs.length} out</span>`;
    attachPaletteDrag(item);
    moduleListEl.appendChild(item);
  }
}

// Persist open/closed state in webview state so it survives reloads while the
// panel is alive. Default: all sections open.
export function initPaletteSections(): void {
  const stored = (vscode.getState?.() as { collapsedSections?: string[] } | undefined) ?? {};
  const collapsed = new Set(stored.collapsedSections ?? []);
  document.querySelectorAll<HTMLElement>(".palette-section").forEach((section) => {
    const key = section.dataset.section ?? "";
    if (collapsed.has(key)) section.classList.add("collapsed");
    const header = section.querySelector<HTMLElement>(".palette-header");
    if (!header) return;
    header.addEventListener("click", () => {
      section.classList.toggle("collapsed");
      if (section.classList.contains("collapsed")) collapsed.add(key);
      else collapsed.delete(key);
      const prev = (vscode.getState?.() as Record<string, unknown> | undefined) ?? {};
      vscode.setState?.({ ...prev, collapsedSections: Array.from(collapsed) });
    });
  });

  document.querySelectorAll<HTMLElement>(".palette .item").forEach(attachPaletteDrag);
}

export function initCanvasDrop(): void {
  svg.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  svg.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    const type = e.dataTransfer.getData("text/bitstream-node") as NodeType | "";
    if (!type) return;
    const moduleRef = e.dataTransfer.getData("text/bitstream-module") || undefined;
    if (type === "MODULE" && (!moduleRef || !(state.doc.modules ?? {})[moduleRef])) return;
    if (type !== "MODULE" && !FIXED_SHAPES[type as NodeType]) return;
    pushHistory();
    const pt = clientToContent(e);
    const node: CircuitNode = {
      id: freshId(),
      type: type as NodeType,
      x: pt.x,
      y: pt.y,
      label: defaultLabel(type, moduleRef),
    };
    if (moduleRef) node.moduleRef = moduleRef;
    const s = shapeOf(node);
    node.x = snap(pt.x - s.w / 2);
    node.y = snap(pt.y - s.h / 2);
    state.doc.nodes.push(node);
    state.selectedNodes = new Set([node.id]);
    state.selectedWire = null;
    syncColorPickerToSelection();
    setDirty(true);
    render();
  });
}
