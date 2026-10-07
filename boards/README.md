# Board data

Everything BITSTREAM.sh knows about FPGAs and boards lives in this directory as
TOML. The `bitstream-boards` crate embeds these files at build time, so adding a
board is a data-only change.

```
boards/
  families/<family>.toml   IO standards and other per-family facts
  devices/<device>.toml    one package pinout: every package pin of one device
  <board>.toml             one board: device, bank voltages, named signals
```

## Sourcing rules

- **Every value comes from a primary source**, and every file lists its sources
  with URLs. Accepted sources:
  - AMD/Xilinx or Lattice package pinout files and datasheets/user guides
  - the board vendor's master constraint file, reference manual or schematic
  - LiteX platform files (`litex-boards`)
- Prefer URLs pinned to a commit or a versioned document over a moving branch.
- **Never invent pin data.** If a value can't be verified, leave it out and add an
  entry to the board's `todo` list (or a `# TODO:` comment in family and device
  files) that explains what is missing.
- Device files are generated mechanically from the vendor pinout file by the
  script named in the file header. Don't edit them by hand; fix the script and
  regenerate.

## Family (`families/*.toml`)

```toml
id = "xilinx-7series"
name = "AMD 7 series"
constraint_format = "xdc"                  # "xdc" or "pcf"
sources = [{ url = "https://...", covers = "IO standards" }]

[[io_standards]]
name = "LVCMOS33"
vcco = 3.3                                 # required bank VCCO; omit if none
bank_types = ["HR"]                        # bank types that support it; omit = all
differential = false
vref = false                               # needs a VREF in the bank
dci = false                                # needs VRN/VRP in the bank
```

## Device (`devices/*.toml`)

```toml
id = "xc7a35t-cpg236"                      # what boards refer to
family = "xilinx-7series"
device = "xc7a35t"
package = "cpg236"
sources = [{ url = "https://.../xc7a35tcpg236pkg.txt" }]
bank_types = { "14" = "HR", "34" = "HR" }  # optional

pins = [
  # name is copied verbatim from the vendor file; the other fields are derived from it.
  { pin = "W5", name = "IO_L12P_T1_MRCC_34", kind = "io", bank = "34", diff = "P", pair = "<N pin>", clock = "MRCC" },
  { pin = "U12", name = "DONE_0", kind = "config", bank = "0" },
  { pin = "A1", name = "GND", kind = "ground" },
]
```

Pin fields:

| field    | meaning |
|----------|---------|
| `pin`    | package pin (`W5`, `35`) |
| `name`   | vendor pin name, verbatim |
| `kind`   | `io` (user IO, possibly dual-purpose), `config` (dedicated config/JTAG), `power`, `ground`, `analog`, `nc`, `other` |
| `bank`   | IO bank, as a string |
| `diff`   | `"P"` or `"N"` if the pin is one leg of a differential pair |
| `pair`   | package pin of the other leg |
| `clock`  | clock-capable input type (`MRCC`, `SRCC`, `GBIN`) |
| `config` | configuration functions shared with this user IO, e.g. `["D00", "MOSI"]` |
| `vref`   | pin can be the bank's VREF |
| `dci`    | `"VRN"` or `"VRP"` |

## Board (`<board>.toml`)

```toml
id = "basys3"                              # used as project.board
name = "Digilent Basys 3"
vendor = "Digilent"
device = "xc7a35t-cpg236"
part = "xc7a35tcpg236-1"
sources = [
  { url = "https://github.com/Digilent/digilent-xdc/blob/<commit>/Basys-3-Master.xdc", covers = "signal pins and IO standards" },
]
todo = []                                  # anything that could not be verified

[config]                                   # optional device-wide settings
config_voltage = 3.3
cfgbvs = "VCCO"

[banks]
"14" = { vcco = 3.3, source = "https://..." }

[signals]
# Names follow the vendor's master constraint file; aliases add silkscreen labels.
"led[0]" = { pin = "U16", io_standard = "LVCMOS33", aliases = ["LD0"] }
clk = { pin = "W5", io_standard = "LVCMOS33", clock = true, aliases = ["CLK100MHZ"] }
```
