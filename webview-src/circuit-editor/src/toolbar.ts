// Toolbar buttons + the input wiring that doesn't belong with any one
// feature module: routing-mode cycle, snap toggle, color picker, module
// name field.

import { setDirty } from "./dirty";
import {
  btnClearColor,
  btnRouting,
  btnSnap,
  colorPicker,
  footer,
  moduleNameInput,
} from "./dom";
import { redo, undo } from "./history";
import { render } from "./render";
import { applySelectionColor, clearSelectionColor, syncColorPickerToSelection } from "./selection";
import { pushHistory, routingStyle, state } from "./state";
import { applyView } from "./view";
import { vscode } from "./vscode-api";
import { rebuildModulePalette } from "./palette";
import type { RoutingStyle } from "./types";

const ROUTING_LABELS: Record<RoutingStyle, string> = {
  curved: "curved",
  straight: "straight",
  manhattan: "right-angle",
};

export function updateRoutingButton(): void {
  btnRouting.textContent = "Wires: " + (ROUTING_LABELS[routingStyle()] ?? routingStyle());
}

export function updateSnapButton(): void {
  btnSnap.textContent = "Snap: " + (state.snapEnabled ? "on" : "off");
}

export function initToolbar(): void {
  moduleNameInput.addEventListener("input", () => {
    state.doc.moduleName = moduleNameInput.value || "circuit";
    setDirty(true);
  });

  document.getElementById("btnNew")!.addEventListener("click", () => {
    if (state.dirty && !confirm("Discard unsaved changes?")) return;
    state.doc = { moduleName: "circuit", nodes: [], wires: [], modules: {}, routingStyle: "curved" };
    state.nextId = 1;
    state.selectedNodes.clear();
    state.selectedWire = null;
    state.pendingWire = null;
    state.history.length = 0;
    state.future.length = 0;
    state.view = { tx: 0, ty: 0, scale: 1 };
    applyView();
    moduleNameInput.value = state.doc.moduleName;
    footer.textContent = "Untitled";
    rebuildModulePalette();
    setDirty(false);
    updateRoutingButton();
    syncColorPickerToSelection();
    render();
  });

  document.getElementById("btnOpen")!.addEventListener("click", () => vscode.postMessage({ type: "open" }));
  document.getElementById("btnSave")!.addEventListener("click", () =>
    vscode.postMessage({ type: "save", payload: state.doc }),
  );
  document.getElementById("btnSaveAs")!.addEventListener("click", () =>
    vscode.postMessage({ type: "save", payload: state.doc, asNew: true }),
  );
  document.getElementById("btnExport")!.addEventListener("click", () =>
    vscode.postMessage({ type: "exportHdl", payload: state.doc }),
  );
  document.getElementById("btnUndo")!.addEventListener("click", undo);
  document.getElementById("btnRedo")!.addEventListener("click", redo);

  btnRouting.addEventListener("click", () => {
    pushHistory();
    const cur = routingStyle();
    state.doc.routingStyle = cur === "curved" ? "straight" : cur === "straight" ? "manhattan" : "curved";
    setDirty(true);
    updateRoutingButton();
    render();
  });

  btnSnap.addEventListener("click", () => {
    state.snapEnabled = !state.snapEnabled;
    updateSnapButton();
  });

  colorPicker.addEventListener("input", () => {
    if (!state.selectedWire && !state.selectedNodes.size) return;
    applySelectionColor(colorPicker.value);
    syncColorPickerToSelection();
  });

  btnClearColor.addEventListener("click", () => {
    if (!state.selectedWire && !state.selectedNodes.size) return;
    clearSelectionColor();
    syncColorPickerToSelection();
  });

  document.getElementById("btnImportModule")!.addEventListener("click", () => {
    // Host needs our moduleName so it can refuse cycles up front.
    vscode.postMessage({ type: "importModule", ownName: state.doc.moduleName });
  });
  document.getElementById("btnImportHdl")!.addEventListener("click", () => {
    vscode.postMessage({ type: "importHdlModule", ownName: state.doc.moduleName });
  });
  document.getElementById("btnReloadModules")!.addEventListener("click", () => {
    const list = Object.entries(state.doc.modules ?? {})
      .filter(([, iface]) => !!iface.file)
      .map(([name, iface]) => ({ name, file: iface.file! }));
    if (!list.length) {
      const statusEl = document.getElementById("status");
      if (statusEl) {
        statusEl.textContent = "No modules to reload";
        setTimeout(() => { statusEl.textContent = ""; }, 1500);
      }
      return;
    }
    vscode.postMessage({ type: "reloadModules", modules: list });
  });
}
