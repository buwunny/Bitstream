// Inbound host → webview messages. The matching outbound side lives in
// toolbar.ts (Save / Open / Export buttons) and dirty.ts (the throttled
// docSync stream).

import { setDirty } from "./dirty";
import { footer, moduleNameInput, status } from "./dom";
import { rebuildModulePalette, initCanvasDrop } from "./palette";
import { render } from "./render";
import { pushHistory } from "./history";
import { syncColorPickerToSelection } from "./selection";
import { state } from "./state";
import { applyView } from "./view";
import { updateRoutingButton } from "./toolbar";
import type { CircuitDoc, ModuleInterface } from "./types";

interface LoadedMsg { type: "loaded"; payload?: CircuitDoc; path?: string; dirty?: boolean; }
interface SavedMsg { type: "saved"; path: string; }
interface ImportedMsg { type: "moduleImported"; name: string; iface: ModuleInterface; }
interface ReloadedMsg {
  type: "modulesReloaded";
  refreshed?: Array<{ name: string; iface: ModuleInterface }>;
  missing?: string[];
}
interface InfoMsg { type: "info" | "error"; message: string; }
type HostMessage = LoadedMsg | SavedMsg | ImportedMsg | ReloadedMsg | InfoMsg;

export function initHostMessageHandling(): void {
  window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    if (msg.type === "loaded") {
      state.doc = msg.payload ?? { moduleName: "circuit", nodes: [], wires: [], modules: {} };
      if (!state.doc.modules) state.doc.modules = {};
      if (!state.doc.routingStyle) state.doc.routingStyle = "curved";
      let maxN = 0;
      for (const n of state.doc.nodes) {
        const m = /^n(\d+)$/.exec(n.id);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      }
      state.nextId = maxN + 1;
      moduleNameInput.value = state.doc.moduleName || "circuit";
      footer.textContent = msg.path ?? "Untitled";
      state.selectedNodes.clear();
      state.selectedWire = null;
      state.pendingWire = null;
      state.history.length = 0;
      state.future.length = 0;
      state.view = { tx: 0, ty: 0, scale: 1 };
      applyView();
      rebuildModulePalette();
      setDirty(!!msg.dirty);
      updateRoutingButton();
      syncColorPickerToSelection();
      render();
    } else if (msg.type === "saved") {
      footer.textContent = msg.path;
      setDirty(false);
      status.textContent = "Saved";
      setTimeout(() => { status.textContent = ""; }, 1500);
    } else if (msg.type === "moduleImported") {
      pushHistory();
      if (!state.doc.modules) state.doc.modules = {};
      state.doc.modules[msg.name] = msg.iface;
      setDirty(true);
      rebuildModulePalette();
      status.textContent = "Imported module: " + msg.name;
      setTimeout(() => {
        if (status.textContent?.startsWith("Imported")) status.textContent = "";
      }, 2000);
    } else if (msg.type === "modulesReloaded") {
      pushHistory();
      if (!state.doc.modules) state.doc.modules = {};
      for (const { name, iface } of (msg.refreshed ?? [])) state.doc.modules[name] = iface;
      setDirty(true);
      rebuildModulePalette();
      render();
      const refreshed = (msg.refreshed ?? []).length;
      const missing = msg.missing ?? [];
      if (missing.length) {
        status.textContent = `Reloaded ${refreshed}, missing: ${missing.join(", ")}`;
      } else {
        status.textContent = `Reloaded ${refreshed} module${refreshed === 1 ? "" : "s"}`;
        setTimeout(() => {
          if (status.textContent?.startsWith("Reloaded")) status.textContent = "";
        }, 2000);
      }
    } else if (msg.type === "info" || msg.type === "error") {
      status.textContent = msg.message;
      if (msg.type === "info") setTimeout(() => { status.textContent = ""; }, 2000);
    }
  });
}

// Drop handling for palette items lives in palette.ts; re-export so main.ts
// can call them in one block without importing two modules just for init.
export { initCanvasDrop };
