# `bitstream.toml` reference

Every BITSTREAM.sh project has a `bitstream.toml` at its root. Paths in it are
relative to that file. Unknown keys are errors, so typos are caught.

## Full example

This example is checked by the test suite (`crates/rules/tests/docs.rs`), so it
always passes `bitstream check`.

```toml
[project]
name = "uart_echo"
version = "0.1.0"
top = "uart_echo"
board = "arty-a7-35"
# part = "xc7a35ticsg324-1L"     # optional: another speed/temperature grade of the board's device

[sources]
files = ["rtl/*.sv", "rtl/uart/*.v"]
include_dirs = ["rtl/include"]
defines = { BAUD = "115200", SIMULATION = "0" }

[constraints]
# Native timing constraints, passed to the vendor tool unchanged.
files = ["constraints/timing.xdc"]

[dependencies]
# Later milestone: resolved and pinned in bitstream.lock.
uart = { git = "https://github.com/example/uart.git", tag = "v1.2.0" }
fifo = { path = "../fifo" }
cdc = { core = "deps/cdc.core" }

[pins]
# A board signal, by the vendor's name or an alias (here the silkscreen label).
clk = { signal = "CLK100MHZ" }
# A bus: element i drives led[i].
led = { signals = ["LD4", "LD5", "LD6", "LD7"] }
# One bit of a bus can be assigned on its own.
"btn[0]" = { signal = "btn[0]" }
# Board signals can be renamed to match the HDL.
uart_rx = { signal = "uart_txd_in" }
uart_tx = { signal = "uart_rxd_out" }
# A raw package pin, with the IO settings spelled out.
dbg = { pin = "G13", io_standard = "LVCMOS33", slew = "slow", drive = 8, pull = "down" }

[sim]
# Later milestone.
simulator = "verilator"
toplevel = "uart_echo_tb"
files = ["sim/uart_echo_tb.sv"]
test_modules = ["test_uart_echo"]
waves = true

[build]
# Later milestone.
toolchain = "vivado"
out_dir = "build"
# tool_path = "/opt/Xilinx/Vivado/2025.1/bin"
```

## `[project]`

| key | required | meaning |
|-----|----------|---------|
| `name` | yes | project name; also the name of generated files (`build/<name>.xdc`) |
| `version` | no | free-form version string |
| `top` | yes | top-level HDL module or entity |
| `board` | yes | board id, a file name in `boards/` (`basys3`, `arty-a7-35`, `icebreaker`) |
| `part` | no | full part number that overrides the board default; must be the same device and package |

## `[sources]`

| key | meaning |
|-----|---------|
| `files` | HDL files or glob patterns. Language follows the extension (`.v`, `.sv`, `.vhd`/`.vhdl`) |
| `include_dirs` | Verilog include directories |
| `defines` | Verilog defines / VHDL generics for the top level, as strings |

## `[constraints]`

| key | meaning |
|-----|---------|
| `files` | native XDC, SDC or PCF files, passed through unchanged. Use them for timing (`create_clock`, I/O delays). Don't place pins here; use `[pins]` |

## `[dependencies]`

Each entry is one of:

```toml
name = { git = "https://…", rev = "…" }   # or tag = "…" / branch = "…" (at most one)
name = { path = "../local/dir" }
name = { core = "path/to/name.core" }     # FuseSoC CAPI2 core file
```

`git` and `path` dependencies may add `core = "…"` to point at a `.core` file
inside them. Resolution and `bitstream.lock` arrive in a later milestone; for
now dependencies are parsed and validated only.

## `[pins]`

Each key is a top-level port name. Use `name` for a scalar or a whole bus, and
`"name[3]"` (quoted) for one bit. Each value sets exactly one location:

| key | meaning |
|-----|---------|
| `signal` | a board signal name or alias (see the board file, e.g. `boards/basys3.toml`) |
| `signals` | list of board signals; element `i` drives `port[i]` |
| `pin` | a package pin (`W5`, or `35` on QFN packages) |
| `pins` | list of package pins; element `i` drives `port[i]` |

Optional settings:

| key | values | meaning |
|-----|--------|---------|
| `io_standard` | e.g. `LVCMOS33`, `LVDS_25` | defaults to the board signal's standard |
| `clock` | `true`/`false` | the port is a clock and must use a clock-capable pin; board clock signals imply `true` |
| `pull` | `up`, `down`, `keeper`, `none` | internal pull resistor; defaults to the board signal's pull (e.g. the Basys 3 PS/2 pins) |
| `slew` | `slow`, `fast` | output slew rate (XDC only) |
| `drive` | mA, e.g. `8` | output drive strength (XDC only) |
| `diff_term` | `true`/`false` | internal differential termination (XDC only) |
| `pin_n` / `signal_n` | pin / signal | negative leg of a differential pair, given explicitly |

### Differential ports

Give the positive leg as `pin`/`signal` and use a differential `io_standard`.
The negative leg is implied by the device's pairing, and `pin_n`/`signal_n` can
spell it out for checking. In generated XDC, a port `x` constrains the HDL ports
`x_p` and `x_n`. On iCE40 the single port `x` goes on the P leg.

## `[sim]` (later milestone)

| key | meaning |
|-----|---------|
| `simulator` | `verilator` (default for Verilog/SV), `icarus`, `nvc` (default for VHDL), `ghdl` |
| `toplevel` | simulation top; defaults to `project.top` |
| `files` | extra simulation-only HDL |
| `test_modules` | Python modules with cocotb tests |
| `waves` | write FST waveforms |

## `[build]` (later milestone)

| key | meaning |
|-----|---------|
| `toolchain` | `vivado` or `yosys-nextpnr`; defaults from the board's family |
| `out_dir` | output directory, default `build` (also used by `bitstream constraints`) |
| `tool_path` | directory containing vendor tool binaries if not on `PATH` |

## Rule checks

`bitstream check` runs these checks against the board data. Each diagnostic has a
stable code:

| code | severity | what |
|------|----------|------|
| `manifest-syntax` | error | TOML syntax error, unknown key or wrong type |
| `missing-location`, `conflicting-location`, `invalid-port`, `duplicate-port`, `invalid-diff-pair`, `invalid-dependency` | error | structural problems in `[pins]` / `[dependencies]` |
| `unknown-board`, `part-mismatch` | error | board not in the database / `part` doesn't match the board's device |
| `unknown-signal`, `unknown-pin` | error | no such board signal / package pin |
| `unknown-io-standard` | error | IO standard not in BITSTREAM.sh's data for the family |
| `bank-voltage` | error | the IO standard needs a different VCCO than the bank provides (warning for unterminated differential inputs) |
| `bank-type` | error | the IO standard isn't available in this bank type (e.g. LVDS in an HR bank) |
| `unknown-bank-voltage` | warning | the board file doesn't record the bank's VCCO |
| `missing-io-standard` | warning | Vivado needs an IO standard on every port |
| `diff-pair` | error | differential standard on a pin without a partner, on an N leg, or with the wrong `pin_n` |
| `clock-pin` | error | clock port on a pin that isn't clock-capable |
| `not-user-io` | error | power, ground, dedicated config or analog pin |
| `dual-purpose-pin` | warning | raw pin shared with a configuration function |
| `duplicate-pin` | error | two ports (or differential legs) on one pin |
| `vref-dci` | error | DCI standard in a bank without VRN/VRP pins (VREF checks: TODO) |
| `unsupported-setting` | warning | setting the target's constraint format can't express |
