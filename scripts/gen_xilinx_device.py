#!/usr/bin/env python3
"""Generate a BITSTREAM.sh device file from an AMD/Xilinx 7 series package pinout.

Usage:
    gen_xilinx_device.py SOURCE OUTPUT [--source-url URL] [--retrieved YYYY-MM-DD]

SOURCE is either an http(s) URL of an AMD package pinout text file, for example
    https://www.xilinx.com/support/packagefiles/a7packages/xc7a35tcpg236pkg.txt
or a path to a local copy of one. When SOURCE is a local path, pass --source-url
with the URL the file was downloaded from so the generated file records it.
OUTPUT is the TOML file to write (for example boards/devices/xc7a35t-cpg236.toml).

Only the Python 3 standard library is used. Downloaded files are kept in memory;
nothing is written except OUTPUT.

Output is deterministic: pins appear in the same order as in the vendor file, and
`bank_types` is sorted by bank number. The only input that is not part of the
vendor file is the retrieval date in the header comment (--retrieved, default
today), so pass --retrieved to reproduce an existing file byte for byte.

Vendor file format
------------------
A header line `Device/Package <device><package> <date> <time>`, a column header
line `Pin  Pin Name  Memory Byte Group  Bank  VCCAUX Group  Super Logic Region
I/O Type  No-Connect`, one whitespace-separated row per package pin, and a trailer
`Total Number of Pins, <n>` that is checked against the number of rows read.

Derivation rules (from the "Pin Name", "Bank" and "I/O Type" columns)
---------------------------------------------------------------------
name    The vendor pin name, verbatim.
bank    The Bank column as a string; omitted when it is NA.
kind    Decided from the pin name:
          IO_*                                   -> io
          VCC* (VCCINT, VCCAUX, VCCBRAM, VCCO_n,
                VCCADC_0, VCCBATT_0)            -> power
          GND* (GND, GNDADC_0)                   -> ground
          dedicated configuration and JTAG pins
                (CONFIG_PINS below, per UG470 Table 2-4 "Dedicated")
                                                 -> config
          XADC dedicated pins (ANALOG_PINS below) -> analog
          NC                                     -> nc
          MGT* (GTP/GTX/GTH transceiver pins, including
                MGTAVCC/MGTAVTT supplies)        -> other
          anything else                          -> other, with a warning on
                                                    stderr so it gets a deliberate
                                                    rule here.
        IO pins must have I/O Type HR or HP, otherwise the script fails.
diff/pair
        `IO_L<n>P_...` and `IO_L<n>N_...` with the same <n> in the same bank are
        the two legs of a differential pair. `pair` is the other leg's package
        pin. Both legs must be bonded out in this package; a leg whose partner is
        absent from the file gets neither `diff` nor `pair`, since it cannot be
        used as a pair. IO_0_<bank> and IO_25_<bank> are single-ended.
clock   "MRCC" or "SRCC" when that token appears in an IO pin name.
config  Multi-function configuration pin functions found in an IO pin name, in
        the order they appear: D00..D31, A00..A28, MOSI, DIN, DOUT, FCS_B,
        FOE_B, FWE_B, ADV_B, RS0, RS1, CSI_B, CSO_B, RDWR_B, EMCCLK, PUDC_B.
        Source: AMD UG470 "7 Series FPGAs Configuration User Guide" (v1.17,
        December 5, 2023), Table 2-4 "Configuration Pin Definitions", rows of type
        "Multi-function":
        https://docs.amd.com/v/u/en-US/ug470_7Series_Config
        Not configuration functions, so never listed: T0..T3 (byte lane), DQS,
        MRCC/SRCC (clock), VREF, VRN/VRP (DCI) and AD<n>P/AD<n>N (XADC inputs).
vref    true when an IO pin name has a VREF token.
dci     "VRN" or "VRP" when that token appears in an IO pin name.
bank_types
        Bank -> I/O Type (HR or HP) for every bank that has IO pins. A bank whose
        IO pins disagree on the type makes the script fail.

Any token in an IO pin name that is not covered above makes the script fail, so
new vendor naming is classified deliberately rather than silently.
"""

import argparse
import datetime
import json
import re
import sys
import urllib.request

SCRIPT = "scripts/gen_xilinx_device.py"
FAMILY = "xilinx-7series"

# Dedicated configuration and JTAG pins (UG470 Table 2-4, type "Dedicated").
CONFIG_PINS = {
    "CCLK_0",
    "CFGBVS_0",
    "DONE_0",
    "INIT_B_0",
    "M0_0",
    "M1_0",
    "M2_0",
    "PROGRAM_B_0",
    "TCK_0",
    "TDI_0",
    "TDO_0",
    "TMS_0",
}

# XADC dedicated analog pins: analog input pair, ADC references, temperature diode.
ANALOG_PINS = {"VP_0", "VN_0", "VREFP_0", "VREFN_0", "DXP_0", "DXN_0"}

# Multi-function configuration functions (UG470 Table 2-4, type "Multi-function").
CONFIG_FUNCTION_RE = re.compile(
    r"^(D(0[0-9]|[12][0-9]|3[01])|A(0[0-9]|1[0-9]|2[0-8])|MOSI|DIN|DOUT|FCS_B|FOE_B"
    r"|FWE_B|ADV_B|RS0|RS1|CSI_B|CSO_B|RDWR_B|EMCCLK|PUDC_B)$"
)
# Tokens that are deliberately not configuration functions.
IGNORED_TOKEN_RE = re.compile(r"^(T[0-3]|DQS|AD[0-9]+[PN])$")

PAIR_RE = re.compile(r"^L([0-9]+)([PN])$")

HEADER_RE = re.compile(r"^Device/Package\s+(\S+)\s+(\S+)\s+(\S+)")
TOTAL_RE = re.compile(r"^Total Number of Pins,\s*([0-9]+)")
COLUMNS = [
    "Pin",
    "Pin Name",
    "Memory Byte Group",
    "Bank",
    "VCCAUX Group",
    "Super Logic Region",
    "I/O Type",
    "No-Connect",
]
# <device><package>, for example xc7a35t + cpg236 or xc7z020 + clg400.
PART_RE = re.compile(r"^(xc7[a-z]+[0-9]+[a-z]*?)([cfrs][a-z]{1,3}[0-9]+)$")


def fail(message):
    sys.exit(f"{SCRIPT}: error: {message}")


def read_source(source):
    if re.match(r"^https?://", source):
        req = urllib.request.Request(source, headers={"User-Agent": "gen_xilinx_device.py"})
        with urllib.request.urlopen(req) as resp:
            data = resp.read()
    else:
        with open(source, "rb") as f:
            data = f.read()
    return data.decode("ascii")


def parse(text):
    """Returns (part, vendor_date, rows) where rows are dicts keyed by COLUMNS."""
    lines = [line.rstrip() for line in text.splitlines()]
    part = vendor_date = total = None
    rows = []
    in_table = False
    for line in lines:
        if not line.strip():
            continue
        if m := HEADER_RE.match(line):
            part, vendor_date = m.group(1), f"{m.group(2)} {m.group(3)}"
            continue
        if m := TOTAL_RE.match(line):
            total = int(m.group(1))
            continue
        if line.startswith("Pin ") and "Pin Name" in line:
            header = re.split(r"\s{2,}", line.strip())
            if header != COLUMNS:
                fail(f"unexpected column header {header}")
            in_table = True
            continue
        if not in_table:
            fail(f"unexpected line before the column header: {line!r}")
        fields = line.split()
        if len(fields) != len(COLUMNS):
            fail(f"expected {len(COLUMNS)} columns: {line!r}")
        rows.append(dict(zip(COLUMNS, fields)))
    if part is None:
        fail("no `Device/Package` header line")
    if total is None:
        fail("no `Total Number of Pins` trailer")
    if total != len(rows):
        fail(f"trailer says {total} pins but {len(rows)} rows were read")
    return part, vendor_date, rows


def classify(name):
    if name.startswith("IO_"):
        return "io"
    if name == "NC":
        return "nc"
    if name.startswith("GND"):
        return "ground"
    if name.startswith("VCC"):
        return "power"
    if name in CONFIG_PINS:
        return "config"
    if name in ANALOG_PINS:
        return "analog"
    if name.startswith("MGT"):
        return "other"
    print(f"{SCRIPT}: warning: no rule for pin name {name!r}, using kind = other", file=sys.stderr)
    return "other"


def io_tokens(name, bank):
    """Splits `IO_<tokens>_<bank>` into tokens, joining `X_B` active-low names."""
    parts = name.split("_")
    if parts[0] != "IO" or parts[-1] != bank:
        fail(f"{name}: expected IO_..._{bank}")
    tokens = []
    for t in parts[1:-1]:
        if t == "B" and tokens:
            tokens[-1] += "_B"
        else:
            tokens.append(t)
    return tokens


def build_pins(rows):
    pins = []
    bank_types = {}
    legs = {}  # (bank, n) -> {"P": index, "N": index}
    for row in rows:
        name = row["Pin Name"]
        bank = None if row["Bank"] == "NA" else row["Bank"]
        pin = {"pin": row["Pin"], "name": name, "kind": classify(name)}
        if bank is not None:
            pin["bank"] = bank
        if pin["kind"] == "io":
            if bank is None:
                fail(f"{row['Pin']} {name}: IO pin without a bank")
            io_type = row["I/O Type"]
            if io_type not in ("HR", "HP"):
                fail(f"{row['Pin']} {name}: unexpected I/O Type {io_type!r}")
            if bank_types.setdefault(bank, io_type) != io_type:
                fail(f"bank {bank} has both {bank_types[bank]} and {io_type} pins")
            tokens = io_tokens(name, bank)
            first = tokens[0]
            if m := PAIR_RE.match(first):
                key = (bank, int(m.group(1)))
                side = m.group(2)
                if side in legs.setdefault(key, {}):
                    fail(f"{name}: duplicate pair leg")
                legs[key][side] = len(pins)
            elif first not in ("0", "25"):
                fail(f"{name}: unknown IO prefix {first!r}")
            config = []
            for t in tokens[1:]:
                if t in ("MRCC", "SRCC"):
                    if "clock" in pin:
                        fail(f"{name}: two clock tokens")
                    pin["clock"] = t
                elif t == "VREF":
                    pin["vref"] = True
                elif t in ("VRN", "VRP"):
                    pin["dci"] = t
                elif CONFIG_FUNCTION_RE.match(t):
                    config.append(t)
                elif IGNORED_TOKEN_RE.match(t):
                    pass
                else:
                    fail(f"{name}: unknown token {t!r}; add a rule for it")
            if config:
                pin["config"] = config
        pins.append(pin)

    pairs = 0
    for key, sides in legs.items():
        if set(sides) != {"P", "N"}:
            continue  # partner not bonded out in this package
        p, n = pins[sides["P"]], pins[sides["N"]]
        p["diff"], p["pair"] = "P", n["pin"]
        n["diff"], n["pair"] = "N", p["pin"]
        pairs += 1
    return pins, bank_types, pairs


FIELD_ORDER = ["pin", "name", "kind", "bank", "diff", "pair", "clock", "config", "vref", "dci"]


def toml_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return "[" + ", ".join(toml_value(x) for x in v) + "]"
    return json.dumps(v)  # ASCII strings: a JSON string is a valid TOML basic string


def render(device, package, source_url, retrieved, vendor_date, pins, bank_types):
    out = [
        f"# Generated by {SCRIPT} -- do not edit by hand; fix the script and regenerate.",
        f"# Source: {source_url}",
        f"# Retrieved: {retrieved} (vendor file dated {vendor_date})",
        "# Pins are listed in vendor file order.",
        "",
        f"id = {toml_value(f'{device}-{package}')}",
        f"family = {toml_value(FAMILY)}",
        f"device = {toml_value(device)}",
        f"package = {toml_value(package)}",
        f"sources = [{{ url = {toml_value(source_url)}, covers = \"package pinout\" }}]",
    ]
    banks = sorted(bank_types, key=int)
    out.append(
        "bank_types = { "
        + ", ".join(f"{toml_value(b)} = {toml_value(bank_types[b])}" for b in banks)
        + " }"
    )
    out.append("")
    out.append("pins = [")
    for pin in pins:
        fields = ", ".join(f"{k} = {toml_value(pin[k])}" for k in FIELD_ORDER if k in pin)
        out.append(f"  {{ {fields} }},")
    out.append("]")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source", help="URL or local path of the AMD package pinout file")
    ap.add_argument("output", help="device TOML file to write")
    ap.add_argument("--source-url", help="URL to record when SOURCE is a local path")
    ap.add_argument("--retrieved", help="retrieval date to record (default: today)")
    args = ap.parse_args()

    is_url = re.match(r"^https?://", args.source) is not None
    source_url = args.source if is_url else args.source_url
    if not source_url:
        fail("SOURCE is a local path; pass --source-url with the URL it came from")
    retrieved = args.retrieved or datetime.date.today().isoformat()

    part, vendor_date, rows = parse(read_source(args.source))
    m = PART_RE.match(part)
    if not m:
        fail(f"cannot split {part!r} into device and package")
    device, package = m.groups()
    pins, bank_types, pairs = build_pins(rows)

    with open(args.output, "w", encoding="ascii", newline="\n") as f:
        f.write(render(device, package, source_url, retrieved, vendor_date, pins, bank_types))

    io = sum(1 for p in pins if p["kind"] == "io")
    clocks = sum(1 for p in pins if "clock" in p)
    print(
        f"{args.output}: {len(pins)} pins, {io} IO, {pairs} pairs, {clocks} clock-capable",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
