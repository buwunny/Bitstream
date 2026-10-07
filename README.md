# BITSTREAM.sh

An open-core FPGA toolkit: one `bitstream.toml` manifest per project, board-aware
pin checks before any vendor build, and generated vendor constraint files. It is
delivered as a VS Code extension backed by a Rust core. This repository holds the
core and the `bitstream` CLI. The extension is a later milestone (see
[ROADMAP.md](ROADMAP.md)).

```toml
[project]
name = "blinky"
top = "blinky"
board = "arty-a7-35"

[sources]
files = ["rtl/blinky.v"]

[pins]
clk = { signal = "CLK100MHZ" }
led = { signals = ["LD4", "LD5", "LD6", "LD7"] }
```

```console
$ bitstream check
    Checked `blinky` for arty-a7-35: 2 pin assignments
$ bitstream constraints
    Checked `blinky` for arty-a7-35: 2 pin assignments
     Wrote build/blinky.xdc
```

When something is wrong, `bitstream check` reports it the way rustc does:

```text
$ bitstream check --manifest-path examples/broken-lvds
error[bank-voltage]: LVDS_25 needs VCCO = 2.5 V, but bank 15 is powered at 3.3 V
  --> examples/broken-lvds/bitstream.toml:17:66
   |
17 | lvds_out = { signal = "jb[0]", signal_n = "jb[1]", io_standard = "LVDS_25" }
   |                       ------- pin E15 is in bank 15 (3.3 V)
   |                                                                  ^^^^^^^^^ requires 2.5 V
   |
   = help: differential IO standards for a 3.3 V bank: TMDS_33; the Digilent Arty A7-35 has no bank powered at 2.5 V

error: could not check `lvds_tx` due to 1 previous error
```

## Features (milestone 1)

- **Manifest**: `bitstream.toml` describes board, top module, sources,
  dependencies, pins, simulation and build settings. Timing constraints stay in
  native XDC/SDC files that pass through unchanged. See
  [docs/manifest.md](docs/manifest.md).
- **Unified pin definitions**: name board signals (`CLK100MHZ`, `LD4`) or raw
  package pins (`E3`). BITSTREAM.sh generates XDC for Vivado and PCF for
  nextpnr-ice40. QSF for Quartus comes later.
- **Board-level rule checks**: IO standard vs. bank VCCO, unsupported bank types,
  differential pairs on non-paired pins, clocks on non-clock-capable pins,
  dedicated and dual-purpose configuration pins, duplicate pins, unknown pins and
  signals, and DCI reference pins. The VREF checks are still a TODO.
- **Boards**: Digilent Basys 3, Digilent Arty A7-35, 1BitSquared iCEBreaker. All
  pin and bank data comes from vendor sources recorded in each file under
  [boards/](boards/).

## Usage

```sh
cargo install --path crates/cli

bitstream init --board basys3 my-project   # write my-project/bitstream.toml
bitstream check                            # rule checks, rustc-style output
bitstream constraints                      # write build/<name>.xdc or .pcf
```

`bitstream build` and `bitstream sim` are placeholders until the vendor build and
simulation milestones.

## Examples

- [`examples/blinky/basys3`](examples/blinky/basys3)
- [`examples/blinky/arty-a7-35`](examples/blinky/arty-a7-35)
- [`examples/blinky/icebreaker`](examples/blinky/icebreaker)
- [`examples/broken-lvds`](examples/broken-lvds): an LVDS pair in a 3.3 V bank,
  which `bitstream check` rejects

## Development

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.

## License

MIT, see [LICENSE](LICENSE). Vendor tools are never bundled. GPL tools
(Verilator, Icarus, NVC, GHDL) are only ever run as separate processes.
