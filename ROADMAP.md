# Roadmap

## Milestone 1: manifest, board data, rule checks, constraints (done)

- `bitstream.toml` schema and parser with spans
- Board data for Digilent Basys 3, Digilent Arty A7-35 and 1BitSquared iCEBreaker
- Board-level rule checks with rustc-style diagnostics
- Deterministic XDC and PCF generation
- `bitstream init`, `check` and `constraints`

## Next milestones, in order

1. **Vendor builds and log parsing.** `bitstream build` drives the user's local
   Vivado (batch mode) and Yosys + nextpnr. Vivado, Yosys and nextpnr output is
   parsed into structured diagnostics with short explanations. Vendor tools are
   never bundled or hosted. Quartus (QSF) follows later.
2. **Simulation with cocotb and FST output.** `bitstream sim` runs cocotb with
   Verilator (default for Verilog/SystemVerilog), Icarus (fallback), NVC (default
   for VHDL) or GHDL (optional). Waveforms are written as FST. GPL simulators run
   as separate processes and are never linked in.
3. **LSP and VS Code extension with an embedded Surfer webview.** `crates/lsp`
   (tower-lsp) publishes manifest and rule diagnostics. `extension/` is a thin
   TypeScript shell that adds tasks, a Test Explorer for cocotb, rule-result and
   build-history views, and an embedded Surfer (WASM) waveform viewer.
4. **`.core` dependencies and the lockfile.** Resolve FuseSoC CAPI2 `.core` files,
   git repos and local paths, and record exact revisions in `bitstream.lock` for
   reproducible builds.
5. **Pin planner webview and a GitHub Action.** An interactive package view for
   assigning pins with live rule checks, plus an Action that runs `bitstream check`
   in CI.
6. **Paid runner orchestration.** Hosted runners that run builds on
   customer-provided vendor tool installations.

## Deferred data and rule work

Each item waits for the milestone or need named in it.

- **VREF checks** (with DDR/MIG support, before vendor builds rely on them).
  Add the VREF voltage to each 7-series IO standard (UG471 Table 1-55) and an
  optional external `vref` per board bank (from the schematic). Then check that
  VREF standards in a bank agree, emit `INTERNAL_VREF` when the board has no
  external VREF, and reject IO on VREF pins when VREF is external.
- **Arty DDR3L pins in bank 34** (with DDR support). Source them from
  Digilent's MIG project file and cross-check with LiteX `digilent_arty.py`.
  They also exercise the 1.35 V bank and VREF checks.
- **LVPECL_25** (on request). UG471 v1.10 doesn't list it; add it only with a
  primary source.
- **iCE40 differential inputs** (with a board that has a 2.5 V bank). Model
  `SB_LVDS_INPUT` from Lattice's iCE40 Technology Library as a differential,
  input-only standard. The SG48 bank-1 pair count disagrees between the pinout
  XLSX (2) and the data sheet (4); recheck against newer Lattice revisions.
- **Board revisions** (low priority). Add `revisions = [...]` to board files to
  state which board revisions the data covers.
- **Exact part matching** (with Quartus or another family). List orderable
  parts per device from vendor ordering information and match `project.part`
  exactly instead of by prefix.
