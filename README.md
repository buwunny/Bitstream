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

## License

MIT
