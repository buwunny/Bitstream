#!/usr/bin/env python3
"""Generate boards/devices/ice40up5k-sg48.toml from Lattice's iCE40UP5K pinout.

Usage:
    python3 scripts/gen_ice40_device.py iCE40UP-5k-Pinout.xlsx > boards/devices/ice40up5k-sg48.toml

The input is the "iCE40UP5K Pinout" spreadsheet from Lattice
(https://www.latticesemi.com/view_document?document_id=51971, saved as
iCE40UP-5k-Pinout.xlsx). Don't commit it. Only the Python standard library is
used, so the .xlsx is read directly as zipped XML.

The spreadsheet columns are FNC (pin name), Pin Type, BANK, Differential Pair,
UWG30 and SG48. Pins with "-" in the SG48 column are not bonded out in SG48 and
are skipped. The SG48 exposed paddle is listed as "Paddle" on several GND rows;
it is emitted once.
"""

import re
import sys
import zipfile
import xml.etree.ElementTree as ET

SOURCE_URL = "https://www.latticesemi.com/view_document?document_id=51971"
SOURCE_FILE = "iCE40UP-5k-Pinout.xlsx"
DATASHEET_URL = "https://www.latticesemi.com/view_document?document_id=51968"
RETRIEVED = "2026-10-06"
PACKAGE_COLUMN = "SG48"

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def read_rows(path):
    """Rows of the first worksheet as lists of strings, keyed by column letter."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{NS}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
        sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row in sheet.iter(f"{NS}row"):
        cells = {}
        for c in row.findall(f"{NS}c"):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find(f"{NS}v")
            if c.get("t") == "s" and v is not None:
                val = shared[int(v.text)]
            elif c.get("t") == "inlineStr":
                val = "".join(t.text or "" for t in c.iter(f"{NS}t"))
            else:
                val = v.text if v is not None else ""
            cells[col] = (val or "").strip()
        rows.append(cells)
    return rows


def parse(path):
    rows = read_rows(path)
    header_idx = next(i for i, r in enumerate(rows) if r.get("A") == "FNC")
    header = rows[header_idx]
    col = {name: letter for letter, name in header.items() if name}
    for needed in ("FNC", "Pin Type", "BANK", "Differential Pair", PACKAGE_COLUMN):
        if needed not in col:
            sys.exit(f"column {needed!r} not found in {path}")
    entries = []
    for r in rows[header_idx + 1 :]:
        name = r.get(col["FNC"], "")
        if not name or name.startswith("#") or name.startswith("*"):
            continue
        entries.append(
            {
                "name": name,
                "type": r.get(col["Pin Type"], ""),
                "bank": r.get(col["BANK"], ""),
                "diff": r.get(col["Differential Pair"], ""),
                "pin": r.get(col[PACKAGE_COLUMN], ""),
            }
        )
    return entries


def classify(e):
    """Kind, bank, clock and config functions of one pinout row."""
    t = e["type"]
    parts = t.split("/")
    bank = e["bank"] if e["bank"].isdigit() else None
    clock = "GBIN" if "GBIN" in parts else None
    config = []
    if t in ("PIO", "DPIO", "DPIO/GBIN", "DPIO/I3C", "LED", "DPIO/CONFIG_SPI"):
        # LED: RGB0..2, open-drain general I/O when the RGB driver is unused
        # (data sheet section 5.1.5). DPIO/I3C: IOT_36b/IOT_37a with I3C pull-ups.
        kind = "io"
        if t == "DPIO/CONFIG_SPI":
            m = re.search(r"_(SPI_[A-Z]+)$", e["name"])
            if not m:
                sys.exit(f"no SPI function in {e['name']!r}")
            config = [m.group(1)]
    elif t == "CONFIG/DPIO/GBIN":
        # IOB_12a_G4_CDONE: shared CDONE/G4 user IO; only bonded in UWG30.
        kind = "io"
        config = ["CDONE"]
    elif t == "CONFIG":
        kind = "config"
    elif t in ("VCC", "VCCIO", "VCCPLL", "VPP"):
        kind = "power"
    elif t == "GND":
        kind = "ground"
    else:
        sys.exit(f"unclassified pin type {t!r} for {e['name']!r}")
    if kind != "io":
        clock = None
    return kind, bank, clock, config


def toml_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def pin_sort_key(pin):
    return (0, int(pin), "") if pin.isdigit() else (1, 0, pin)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    entries = parse(sys.argv[1])

    # The Differential Pair column names the other leg by its base name
    # (IOB_3b for IOB_3b_G6), so index IO pins by that prefix.
    by_name = {}
    for e in entries:
        m = re.match(r"IO[BT]_\d+[ab]", e["name"])
        if m:
            by_name[m.group(0)] = e
    bonded = {}
    skipped = []
    for e in entries:
        pin = e["pin"]
        if not pin or pin == "-":
            skipped.append(e["name"])
            continue
        if pin in bonded:
            prev = bonded[pin]
            if prev["name"] == e["name"] == "GND":
                continue  # SG48 lists every GND row on the paddle
            sys.exit(f"pin {pin} used by {prev['name']} and {e['name']}")
        bonded[pin] = e

    lines = []
    notes = []
    for pin in sorted(bonded, key=pin_sort_key):
        e = bonded[pin]
        kind, bank, clock, config = classify(e)
        fields = [f"pin = {toml_str(pin)}", f"name = {toml_str(e['name'])}", f"kind = {toml_str(kind)}"]
        if bank is not None:
            fields.append(f"bank = {toml_str(bank)}")
        m = re.fullmatch(r"(TRUE|COMP)_of_(\S+)", e["diff"])
        if e["diff"] and not m:
            sys.exit(f"unrecognised differential pair entry {e['diff']!r}")
        if m:
            other = by_name.get(m.group(2))
            if other is None:
                sys.exit(f"{e['name']}: pair {m.group(2)!r} not in pinout")
            other_pin = other["pin"]
            if other_pin and other_pin != "-":
                side = "P" if m.group(1) == "TRUE" else "N"
                fields.append(f"diff = {toml_str(side)}")
                fields.append(f"pair = {toml_str(other_pin)}")
            else:
                notes.append(
                    f"{e['name']} (pin {pin}) is {m.group(1)}_of_{m.group(2)}, "
                    f"but {m.group(2)} is not bonded in {PACKAGE_COLUMN}; no pair emitted."
                )
        if clock:
            fields.append(f"clock = {toml_str(clock)}")
        if config:
            fields.append("config = [" + ", ".join(toml_str(c) for c in config) + "]")
        lines.append("  { " + ", ".join(fields) + " },  # Pin Type: " + e["type"])

    out = []
    out.append(f"# Generated by scripts/gen_ice40_device.py from {SOURCE_FILE}")
    out.append(f"# Source: {SOURCE_URL} (retrieved {RETRIEVED})")
    out.append("# Do not edit by hand: fix the script and regenerate.")
    out.append("#")
    out.append("# TRUE_of_X / COMP_of_X in the pinout's Differential Pair column become diff = P / N.")
    out.append("# Pins whose package column is \"-\" are not bonded in this package and are left out:")
    out.append("#   " + ", ".join(skipped))
    for n in notes:
        out.append("# " + n)
    out.append(
        "# Pin Type LED (RGB0..RGB2) are kind io: per data sheet FPGA-DS-02008 v2.4 section 5.1.5 they"
    )
    out.append(
        "# are open-drain I/O when the RGB driver is unused, or open-drain 24 mA LED current sinks."
    )
    out.append(
        "# Pin Type DPIO/I3C (IOT_36b, IOT_37a) are user IO with the I3C interface option."
    )
    out.append(
        "# TODO: the data sheet (FPGA-DS-02008 v2.4, Pin Information Summary) lists 4 differential"
    )
    out.append(
        "# pairs in bank 1 for SG48, but the pinout file marks only IOB_22a/IOB_23b and"
    )
    out.append(
        "# IOB_24a/IOB_25b_G3 as bonded bank 1 pairs; the SPI pins have no pair entry. Pairs follow"
    )
    out.append("# the pinout file until Lattice clarifies.")
    out.append("")
    out.append('id = "ice40up5k-sg48"')
    out.append('family = "ice40"')
    out.append('device = "ice40up5k"')
    out.append('package = "sg48"')
    out.append("sources = [")
    out.append(
        f'  {{ url = "{SOURCE_URL}", covers = "iCE40UP5K pinout ({SOURCE_FILE}, revision 1.1, updated Jun 19, 2017), SG48 column" }},'
    )
    out.append(
        f'  {{ url = "{DATASHEET_URL}", covers = "pin functions (FPGA-DS-02008 v2.4, section 5): kinds of LED and I3C pin types" }},'
    )
    out.append("]")
    out.append("")
    out.append("pins = [")
    out.extend(lines)
    out.append("]")
    print("\n".join(out))


if __name__ == "__main__":
    main()
