# Bitstream

A unified, git-friendly FPGA development extension for VS Code. Bitstream wraps Xilinx Vivado and Intel Quartus behind a single manifest file (`bitstream.json`) and a consistent set of commands, so you never have to touch a vendor GUI or check in gigabytes of generated project files.

## Purpose

FPGA toolchains are notoriously hard to use from the command line and nearly impossible to version-control cleanly. Vivado and Quartus each maintain opaque, binary-heavy project directories that bloat repositories and break `git diff`. Bitstream solves this by treating `bitstream.json` as the single source of truth — a small, human-readable JSON file that describes your project. All vendor artifacts (Tcl scripts, `.xpr` files, Quartus project directories) are derived from the manifest on demand and gitignored.

## Goals

- **Git-friendly by design** — only `bitstream.json`, your HDL sources, and constraint files are checked in. Everything regenerable is ignored.
- **Headless builds** — synthesize, implement, and program your FPGA entirely from the VS Code command palette or status bar, with live output streamed to an output channel.
- **No vendor lock-in UI** — one extension, one workflow for both Xilinx and Intel devices.
- **Fast iteration** — lint on save (Verilator), IntelliSense via Verible LSP, and one-click simulation with waveform viewing.

## Features

### Project Management
- **New Project Wizard** — guided setup that creates `bitstream.json` and a `.gitignore` tailored to your vendor (Xilinx or Intel).
- **Auto-manifest sync** — a file system watcher keeps `bitstream.json` in sync as you add or remove `.v`, `.sv`, `.vhd`, and constraint files from the workspace. Testbenches (`*_tb.*` / `tb_*.*`) are automatically separated from synthesizable sources.
- **Project Explorer** — a dedicated activity bar panel showing your source files, testbenches, constraints, and top module at a glance.

### Build & Upload
- **One-click build** — the `Build Bitstream` status bar button generates vendor Tcl from `bitstream.json` and runs Vivado or Quartus in batch/headless mode. No GUI opens.
  - Vivado: in-memory project (no `.xpr` on disk), full synth → opt → place → route → `write_bitstream`.
  - Quartus: generates a `quartus_project/` directory (gitignored), then runs `quartus_map` → `quartus_fit` → `quartus_asm` in sequence.
- **One-click upload** — the `Upload to Board` status bar button programs the connected FPGA over JTAG using Vivado's hardware manager or `quartus_pgm`.
- **Live output** — build and upload output streams to a dedicated `Bitstream: Toolchain` output channel in real time.

### Linting & IntelliSense
- **Verilator linting** — runs `verilator --lint-only` on every save of a `.v` or `.sv` file and surfaces errors and warnings in VS Code's Problems tab. Configurable binary path.
- **Verible LSP** — starts `verible-verilog-ls` as a language server for Verilog and SystemVerilog, providing hover, go-to-definition, and completion. Gracefully degrades if Verible is not installed.
- **Syntax highlighting** — TextMate grammars for Verilog (`.v`/`.vh`), SystemVerilog (`.sv`/`.svh`), and VHDL (`.vhd`/`.vhdl`).

### Simulation
- **Icarus Verilog integration** — compile and run testbenches with a single command. Bitstream picks the active testbench from the manifest (or prompts when there are multiple) and runs `iverilog` + `vvp`.
- **GTKWave integration** — after a successful simulation run, offers to open the produced VCD/FST waveform in GTKWave.

### Pin Planner
- **Webview pin assignment editor** — parses the top module's port list from source and presents a table where you assign device pins to ports. Assignments are saved back into `bitstream.json` under `pin_map`.
- **Constraint file generation** — emits vendor-appropriate constraint files from the pin map:
  - Xilinx → `constraints/<top>_pins.xdc` (`set_property PACKAGE_PIN` / `IOSTANDARD LVCMOS33`)
  - Intel → `constraints/<top>_pins.qsf` (`set_location_assignment`)

### Tcl Console
- **Interactive Tcl console** — opens a terminal running the vendor's Tcl shell for ad-hoc scripting and debugging without leaving VS Code.

## Requirements

The extension activates on any workspace containing `bitstream.json` or when a Verilog/SystemVerilog/VHDL file is opened. External tools are only required for the features that use them:

| Feature | Tool |
|---|---|
| Build (Xilinx) | Vivado (`vivado`) |
| Build (Intel) | Quartus (`quartus_map`, `quartus_fit`, `quartus_asm`, `quartus_pgm`) |
| Lint on save | Verilator (`verilator`) |
| IntelliSense | Verible (`verible-verilog-ls`) |
| Simulation | Icarus Verilog (`iverilog`, `vvp`) |
| Waveform viewing | GTKWave (`gtkwave`) |

All tool paths are configurable under **Settings → Bitstream** (`hdlToolchain.*`). If a tool is on your system `PATH`, no configuration is needed.

## Getting Started

1. Open a folder in VS Code.
2. Run **Bitstream: New Project Wizard** from the command palette.
3. Add your HDL source files — the manifest syncs automatically.
4. Set a top module via **Bitstream: Set Top Module** or the Project Explorer context menu.
5. Assign pins in the **Pin Planner** and generate constraint files.
6. Click **Build Bitstream** in the status bar to synthesize, then **Upload to Board** to program.

## The `bitstream.json` Manifest

```json
{
  "project_name": "my_fpga",
  "vendor": "xilinx",
  "device": "xc7a35tcpg236-1",
  "top_module": "top",
  "source_files": ["src/top.v", "src/uart.v"],
  "testbenches": ["tb/top_tb.v"],
  "constraints": ["constraints/top_pins.xdc"],
  "pin_map": {
    "clk": "W5",
    "led": "U16"
  }
}
```

The manifest is the only file you need to commit alongside your HDL. A fresh clone plus `bitstream.json` is enough to fully rebuild the project.

## Roadmap

Items are grouped by phase. Within each phase they are roughly ordered by effort, lightest first.

### Phase 1 — Analysis & Reporting

Parse the artifacts that `bitstream.buildBitstream` already produces and surface them in the UI. No new external tools required.

- [ ] **Utilization dashboard** — webview that parses `utilization.rpt` and `*.fit.summary` after every build, showing LUT / FF / BRAM / DSP / IO percentages with a per-module breakdown.
- [ ] **Timing summary panel** — extract WNS / TNS / WHS / THS / Fmax from `report_timing_summary` and `quartus_sta` output; status-bar badge turns red on negative slack.
- [ ] **Critical path inspector** — list the worst N timing paths, click to jump to the source RTL line via the existing hierarchy index in [src/hierarchy.ts](src/hierarchy.ts).
- [ ] **Build history & regression tracking** — append `{commit, utilization, wns, fmax, build_time}` to `.bitstream/history.json` after each successful build; plot trends in a webview.
- [ ] **Pin / IO timing report** — surface input setup, clock-to-out, and IO standard mismatches in the Problems tab, cross-linked to the [Pin Planner](src/pinplanner.ts).
- [ ] **Latch & inferred-flop detector** — parse synthesis warnings, mark offending lines with a diagnostic.

### Phase 2 — Lint, Verification & Debug

Wrap open-source verification tooling behind the same one-click UX as the existing Verilator integration in [src/linter.ts](src/linter.ts).

- [ ] **CDC (clock-domain-crossing) lint** — static pass over the parsed netlist (Yosys JSON) detecting signals sampled across clock domains without synchronizer chains.
- [ ] **RDC (reset-domain-crossing) lint** — same approach for async resets crossing domains.
- [ ] **Naming / style / synthesizability linter** — configurable rule set (`bitstream.lint.rules` in the manifest); covers Verilator-missed cases like blocking-assignment-in-sequential, missing default cases, undriven nets.
- [ ] **Formal property checking** — wrap `symbiyosys` so users can add SVA / immediate assertions in their RTL and run `bmc`, `prove`, `cover` from the command palette.
- [ ] **Code coverage heatmap** — Verilator already emits line/branch/toggle coverage; render it as editor gutter decorations and a per-module summary.
- [ ] **Functional coverage & cover-group reports** — parse SystemVerilog covergroups via Verilator or `symbiyosys`.
- [ ] **In-system logic analyzer** — insert a debug core that captures signals to BRAM, triggered on a user-defined condition; dump over JTAG via OpenOCD or `xsdb`; auto-open the result in GTKWave.
- [ ] **Virtual I/O (VIO)** — a webview with toggles and LEDs that maps to debug registers in the synthesized design, polled over JTAG.
- [ ] **Waveform compare** — diff two VCD/FST files (golden vs. current run) and report the first divergence per signal.

### Phase 3 — Synthesis, Implementation & Floorplan

Make the synthesis flow visible and tractable to edit, not just a black box.

- [ ] **RTL schematic viewer** — run `yosys -p "read_verilog ...; proc; opt; show -format json"` on the manifest sources and render the netlist in the existing [circuit editor webview](src/circuit_editor/circuit-webview.ts).
- [ ] **Post-synthesis netlist viewer** — same renderer, but after `synth_xilinx` / `synth_intel` so users can see how their RTL mapped to LUTs / DSPs / BRAMs.
- [ ] **Floorplan / device-view heatmap** — parse the placement report and draw the device fabric as a grid, colour-coded by module ownership or utilisation density.
- [ ] **Incremental compile** — hash sources, constraints, and tool versions per stage; skip synth when only constraints changed, skip P&R when the synth-hash matches.
- [ ] **Multi-strategy implementation runs** — kick off N parallel builds with different synthesis / placement / routing directives; pick the best by WNS.
- [ ] **Multi-target build matrix** — same RTL, multiple devices (e.g. `xc7a35t` and `xc7a100t`); useful for board-bringup and SoC variants.
- [ ] **Retiming and physical-optimization reports** — surface what the tool moved or replicated and why.

### Phase 4 — IP, Block Design & HLS

Make composition first-class so users don't have to hand-instantiate boilerplate.

- [ ] **Parameterized IP catalog** — drop-in cores for FIFOs, BRAM, MMCM/PLL clock wizards, AXI4-Lite bridges, UART, SPI, I2C, DDR controllers.
- [ ] **Block-design / IP integrator** — extend [circuit_editor/](src/circuit_editor/) to instantiate IP, draw connections between AXI/Avalon interfaces, and emit a top-level wrapper into `source_files`.
- [ ] **Bus / interface inference** — detect AXI / Avalon / Wishbone port bundles in user RTL and group them automatically.
- [ ] **AXI / protocol checkers** — synthesizable monitors that flag spec violations during simulation.
- [ ] **Register-map / CSR generator** — author a `regmap.yaml` per IP and emit the RTL, C headers, and Markdown docs.
- [ ] **IP packager** — export a folder as a reusable IP block with its own manifest fragment.
- [ ] **High-level synthesis (HLS)** — optional integration with `bambu` or `XLS` to compile C / C++ / DSLX to RTL and inject the result into `source_files`.

### Phase 5 — Productivity, Power & Deployment

- [ ] **Power estimator** — combine VCD switching activity from simulation with device characterisation tables to produce a per-module dynamic + static power breakdown.
- [ ] **Thermal estimator** — extend the power model with package thermal resistance to flag designs that exceed Tj at the target ambient.
- [ ] **Constraint wizard** — generate XDC / SDC / QSF templates for common patterns (clock definitions, IO standards, false paths, multicycle paths).
- [ ] **Bitstream encryption & signing** — `write_bitstream -encrypt` / `quartus_cpf` wrappers with key management stored outside the repo.
- [ ] **Remote / cloud build offload** — ship the manifest plus sources to a remote runner (SSH or GitHub Actions); stream the same `Bitstream: Toolchain` output back to the local channel.
- [ ] **Remote programming** — program a board attached to another machine over the network (xvcd, ftd2xx-over-TCP).
- [ ] **OTA / partial-reconfiguration tooling** — manage partial bitstreams and update flows for devices that support dynamic partial reconfiguration.
- [ ] **Auto-generated documentation** — emit a Markdown page per project with the block diagram, register map, pin map, utilization, and timing summary.

### Phase 6 — Simulation upgrades

The current flow in [src/simulation.ts](src/simulation.ts) is single-testbench Icarus + GTKWave. The items below scale it to a full regression flow.

- [ ] **Mixed-language simulation** — drop in `nvc` or `ghdl` + `cocotb` so a single testbench can drive both Verilog and VHDL DUTs.
- [ ] **cocotb / Python testbench runner** — first-class command-palette support; surface pass/fail counts in the Problems tab.
- [ ] **Regression runner** — run every `*_tb.*` file in the manifest, parallelised across cores, with a webview pass/fail grid.
- [ ] **Coverage merge across runs** — accumulate Verilator coverage from a regression and report the union.
- [ ] **Simulation performance profiler** — show which always-blocks and modules dominate simulator time.

## License

MIT
