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
