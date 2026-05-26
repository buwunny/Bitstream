/**
 * wizard.ts
 * ----------------------------------------------------------------------------
 * Webview-based new-project wizard. The host (this file) owns the project
 * directory creation and manifest scaffolding; the webview is presentation
 * only and talks to the host via a tiny postMessage protocol:
 *
 *     webview ->  { type: "submit", payload: ProjectConfig }
 *     webview ->  { type: "browse" }                  (open native folder picker)
 *     webview ->  { type: "cancel" }
 *     host    ->  { type: "browseResult", path }       (response to "browse")
 *     host    ->  { type: "error", message }           (validation failures)
 *
 * After a successful submit we materialise `bitstream.json`, the source
 * tree (`src/`, `constraints/`, `sim/`), a vendor-aware `.gitignore`, then
 * call `vscode.openFolder` so the workspace reloads on the new project.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
    BitstreamManifest,
    Vendor,
    writeManifest,
    writeGitignore,
    MANIFEST_FILE,
} from "./manifest";
import { XILINX_DEVICES, INTEL_DEVICES, DeviceOption } from "./devices";

interface ProjectConfig {
    projectName: string;
    vendor: Vendor;
    device: string;
    rootPath: string;
}

export class ProjectWizard {
    public static readonly viewType = "bitstream.wizard";
    private static current: ProjectWizard | undefined;

    public static show(extensionUri: vscode.Uri): void {
        if (ProjectWizard.current) {
            ProjectWizard.current.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ProjectWizard.viewType,
            "Bitstream: New Project",
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                // Restrict resource loading to the extension dir + the
                // webview-ui-toolkit module so the webview can't reach
                // arbitrary user files.
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, "node_modules", "@vscode-elements", "elements"),
                    vscode.Uri.joinPath(extensionUri, "media"),
                ],
            },
        );
        ProjectWizard.current = new ProjectWizard(panel, extensionUri);
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.panel.webview.html = this.renderHtml();

        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg).catch((err) => {
                this.panel.webview.postMessage({ type: "error", message: String(err?.message ?? err) });
            }),
            null,
            this.disposables,
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async handleMessage(msg: any): Promise<void> {
        switch (msg?.type) {
            case "browse": {
                // Native folder picker — webviews aren't allowed to touch
                // the filesystem, so we delegate to the host here.
                const uri = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: "Select Project Root",
                });
                this.panel.webview.postMessage({
                    type: "browseResult",
                    path: uri && uri[0] ? uri[0].fsPath : "",
                });
                return;
            }
            case "submit": {
                await this.createProject(msg.payload as ProjectConfig);
                return;
            }
            case "cancel": {
                this.panel.dispose();
                return;
            }
        }
    }

    private async createProject(config: ProjectConfig): Promise<void> {
        // Validate everything host-side; the webview's checks are advisory.
        const errors: string[] = [];
        if (!config.projectName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(config.projectName)) {
            errors.push("Project name must start with a letter and contain only letters, digits, or underscores.");
        }
        if (config.vendor !== "xilinx" && config.vendor !== "intel") {
            errors.push("Vendor must be either 'xilinx' or 'intel'.");
        }
        if (!config.device) { errors.push("Target device/part is required."); }
        if (!config.rootPath || !fs.existsSync(config.rootPath)) {
            errors.push("Root path must point to an existing directory.");
        }
        if (errors.length) { throw new Error(errors.join(" ")); }

        const projectDir = path.join(config.rootPath, config.projectName);
        if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length > 0) {
            throw new Error(`Target directory '${projectDir}' already exists and is not empty.`);
        }
        fs.mkdirSync(projectDir, { recursive: true });
        for (const sub of ["src", "constraints", "sim"]) {
            fs.mkdirSync(path.join(projectDir, sub), { recursive: true });
        }

        // Drop a placeholder top-level module so the project compiles immediately.
        const topPath = path.join(projectDir, "src", `${config.projectName}.sv`);
        fs.writeFileSync(
            topPath,
            `// Auto-generated stub. Replace with your top-level module.\nmodule ${config.projectName} (\n    input  logic clk,\n    input  logic rst_n\n);\n\nendmodule\n`,
            "utf8",
        );

        const manifest: BitstreamManifest = {
            project_name: config.projectName,
            vendor: config.vendor,
            device: config.device,
            top_module: config.projectName,
            source_files: [`src/${config.projectName}.sv`],
            testbenches: [],
            constraints: [],
        };
        writeManifest(projectDir, manifest);
        writeGitignore(projectDir, config.vendor);

        this.panel.dispose();

        // Reload the workspace on the newly-created folder. With
        // forceNewWindow=false, the current window is replaced — the user's
        // next session lands directly inside their new project.
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(projectDir), false);
    }

    private renderHtml(): string {
        const elementsUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.extensionUri,
                "node_modules", "@vscode-elements", "elements", "dist", "bundled.js",
            ),
        );
        const nonce = randomNonce();
        const csp = [
            `default-src 'none'`,
            `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${this.panel.webview.cspSource}`,
        ].join("; ");

        // Each "step" is just a section with a different `data-step` value;
        // the inline script toggles visibility. Keeping all steps in one DOM
        // lets the user navigate back and forth without losing input.
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Bitstream: New Project</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 1.5rem; color: var(--vscode-foreground); }
  h1 { font-size: 1.3rem; margin-bottom: 1rem; }
  .step { display: none; }
  .step.active { display: block; }
  .row { margin: 0.75rem 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.5rem; justify-content: space-between; }
  .browse-row { display: flex; gap: 0.5rem; align-items: end; }
  .browse-row vscode-textfield { flex: 1; }
  .error { color: var(--vscode-errorForeground); margin-top: 0.5rem; min-height: 1.2em; }
  .stepper { display: flex; gap: 0.5rem; margin-bottom: 1rem; opacity: 0.7; font-size: 0.85rem; }
  .stepper span.current { color: var(--vscode-textLink-foreground); font-weight: bold; }
</style>
</head>
<body>
  <h1>New Bitstream Project</h1>
  <div class="stepper">
    <span data-stepnum="1">1. Name</span> ›
    <span data-stepnum="2">2. Vendor</span> ›
    <span data-stepnum="3">3. Device</span> ›
    <span data-stepnum="4">4. Location</span>
  </div>

  <section class="step" data-step="1">
    <div class="row">
      <label for="projectName">Project Name</label>
      <vscode-textfield id="projectName" placeholder="my_project"></vscode-textfield>
      <small>Letters, digits, underscores. Must start with a letter.</small>
    </div>
  </section>

  <section class="step" data-step="2">
    <div class="row">
      <label>Vendor</label>
      <vscode-radio-group id="vendor" variant="vertical">
        <vscode-radio value="xilinx" label="Xilinx (Vivado)" checked></vscode-radio>
        <vscode-radio value="intel" label="Intel / Altera (Quartus)"></vscode-radio>
      </vscode-radio-group>
    </div>
  </section>

  <section class="step" data-step="3">
    <div class="row">
      <label for="device">Target Device / Part</label>
      <vscode-single-select
        id="device"
        combobox
        creatable
        filter="fuzzy"
        placeholder="Type to search (e.g. artix, zynq, cyclone) or paste a custom part"
      ></vscode-single-select>
      <small>Searchable list of common parts. Not listed? Just type the exact part string and press Enter.</small>
    </div>
  </section>

  <section class="step" data-step="4">
    <div class="row">
      <label for="rootPath">Root Path</label>
      <div class="browse-row">
        <vscode-textfield id="rootPath" placeholder="/path/to/parent/dir"></vscode-textfield>
        <vscode-button id="browseBtn" appearance="secondary">Browse…</vscode-button>
      </div>
      <small>Project will be created at &lt;rootPath&gt;/&lt;projectName&gt;.</small>
    </div>
  </section>

  <div class="error" id="errorBox"></div>

  <div class="actions">
    <vscode-button id="cancelBtn" appearance="secondary">Cancel</vscode-button>
    <div>
      <vscode-button id="backBtn" appearance="secondary">Back</vscode-button>
      <vscode-button id="nextBtn">Next</vscode-button>
      <vscode-button id="createBtn" style="display:none">Create Project</vscode-button>
    </div>
  </div>

  <script type="module" nonce="${nonce}" src="${elementsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TOTAL_STEPS = 4;
    let step = 1;

    // Device catalogs injected from the host. Switched live when vendor changes.
    const DEVICE_CATALOG = ${JSON.stringify({ xilinx: XILINX_DEVICES, intel: INTEL_DEVICES })};

    function populateDevices(vendor) {
      const select = document.getElementById('device');
      if (!select) { return; }
      const previous = select.value;
      // Reset selection before swapping options so stale state doesn't leak.
      select.value = '';
      const list = DEVICE_CATALOG[vendor] || [];
      // vscode-single-select reads <vscode-option> children, so we rebuild them.
      select.innerHTML = list.map(
        (d) => '<vscode-option value="' + d.value + '">' + d.label + '</vscode-option>'
      ).join('');
      // Preserve the user's choice when it remains valid under the new vendor
      // (or when they typed a custom part the catalog doesn't include).
      if (previous && (list.some((d) => d.value === previous) || !list.length)) {
        select.value = previous;
      }
    }

    const q = (sel) => document.querySelector(sel);
    const stepEls = () => document.querySelectorAll('.step');
    const stepperEls = () => document.querySelectorAll('.stepper span');
    const errorBox = q('#errorBox');

    function render() {
      stepEls().forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.step) === step);
      });
      stepperEls().forEach((el) => {
        el.classList.toggle('current', Number(el.dataset.stepnum) === step);
      });
      q('#backBtn').disabled = step === 1;
      q('#nextBtn').style.display = step === TOTAL_STEPS ? 'none' : '';
      q('#createBtn').style.display = step === TOTAL_STEPS ? '' : 'none';
      errorBox.textContent = '';
    }

    function collect() {
      // VS Code Elements radio-group exposes its selection as a 'value' property.
      const group = q('#vendor');
      const vendor = (group && group.value)
        || (document.querySelector('vscode-radio[checked]') || {}).value
        || 'xilinx';
      return {
        projectName: q('#projectName').value.trim(),
        vendor,
        device: String(q('#device').value || '').trim(),
        rootPath: q('#rootPath').value.trim(),
      };
    }

    function validateStep(s, data) {
      if (s === 1 && !/^[A-Za-z][A-Za-z0-9_]*$/.test(data.projectName)) {
        return 'Project name must start with a letter and contain only letters, digits, or underscores.';
      }
      if (s === 3 && !data.device) { return 'Target device is required.'; }
      if (s === 4 && !data.rootPath) { return 'Root path is required.'; }
      return '';
    }

    q('#nextBtn').addEventListener('click', () => {
      const data = collect();
      const err = validateStep(step, data);
      if (err) { errorBox.textContent = err; return; }
      step = Math.min(TOTAL_STEPS, step + 1);
      render();
    });
    q('#backBtn').addEventListener('click', () => { step = Math.max(1, step - 1); render(); });
    q('#cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    q('#browseBtn').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
    q('#createBtn').addEventListener('click', () => {
      const data = collect();
      for (let s = 1; s <= TOTAL_STEPS; s++) {
        const err = validateStep(s, data);
        if (err) { errorBox.textContent = err; step = s; render(); return; }
      }
      vscode.postMessage({ type: 'submit', payload: data });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'browseResult' && msg.path) {
        q('#rootPath').value = msg.path;
      } else if (msg.type === 'error') {
        errorBox.textContent = msg.message;
      }
    });

    // Repopulate the device dropdown whenever the vendor radio changes.
    // 'vsc-change' is the framework-agnostic event vscode-radio-group emits.
    q('#vendor').addEventListener('change', (e) => populateDevices(e.target.value || 'xilinx'));
    q('#vendor').addEventListener('vsc-change', (e) => populateDevices(e.target.value || 'xilinx'));

    // Seed the device list once the custom elements have upgraded.
    customElements.whenDefined('vscode-single-select').then(() => populateDevices('xilinx'));

    render();
  </script>
</body>
</html>`;
    }

    public dispose(): void {
        ProjectWizard.current = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

function randomNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return out;
}
