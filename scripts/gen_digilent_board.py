#!/usr/bin/env python3
"""Regenerate the [signals] table of a board file from a Digilent master XDC.

Usage:
    gen_digilent_board.py BOARD.toml MASTER.xdc [--pkg PACKAGE.txt] [--check]

Every `set_property -dict { PACKAGE_PIN ... }` line of the XDC becomes one signal,
whether or not it is commented out (Digilent ships every line commented). The XDC
port name is the signal key, verbatim. `clock = true` is set for ports that have a
`create_clock` in the XDC. The description combines the XDC section heading and the
line's trailing comment.

Everything above the `[signals]` line of BOARD.toml is kept verbatim, and so are
the `aliases` of existing signals: aliases are curated by hand from the sources
listed in the file header, everything else is regenerated.

With --pkg, every pin is checked against the AMD package pinout file
(xc7a35tcpg236pkg.txt and friends): it must exist and be a user IO (`IO_*`).
A per-bank summary and the true P/N pairs among the signals are printed.

With --check, BOARD.toml is not written; the script exits non-zero if it would
change.

Standard library only (Python 3.11+ for tomllib).
"""

import argparse
import re
import sys
import tomllib
from collections import defaultdict

SET_PROPERTY = re.compile(
    r"^\s*#?\s*set_property\s+-dict\s+\{(?P<props>[^}]*)\}\s*"
    r"\[\s*get_ports\s+(?:\{\s*(?P<p1>[^}]*?)\s*\}|(?P<p2>\S+?))\s*\]\s*;?\s*(?P<rest>.*)$"
)
CREATE_CLOCK = re.compile(
    r"^\s*#?\s*create_clock\b.*\[\s*get_ports\s+(?:\{\s*([^}]*?)\s*\}|(\S+?))\s*\]"
)
SECTION = re.compile(r"^\s*##\s*(?P<title>.*\S)\s*$")
BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def parse_xdc(text):
    """Returns (signals, clocks): signals in file order, clocks as a set of ports."""
    signals = []
    clocks = set()
    section = None
    in_heading = False
    for lineno, line in enumerate(text.splitlines(), 1):
        # A section title is the first line of a block of `##` comments; the lines
        # after it are notes.
        m = SECTION.match(line)
        if m and not in_heading:
            section = m.group("title")
        in_heading = bool(m)
        m = SET_PROPERTY.match(line)
        if m:
            props = m.group("props").split()
            if len(props) % 2:
                sys.exit(f"line {lineno}: odd property list: {line}")
            props = dict(zip(props[0::2], props[1::2]))
            port = (m.group("p1") or m.group("p2")).strip()
            if "PACKAGE_PIN" not in props:
                sys.exit(f"line {lineno}: no PACKAGE_PIN: {line}")
            comment = m.group("rest").strip().lstrip("#").strip()
            signals.append(
                {
                    "port": port,
                    "pin": props.pop("PACKAGE_PIN"),
                    "io_standard": props.pop("IOSTANDARD", None),
                    "other": props,
                    "section": section,
                    "comment": " ".join(comment.split()),
                    "line": lineno,
                }
            )
            continue
        m = CREATE_CLOCK.match(line)
        if m:
            clocks.add((m.group(1) or m.group(2)).strip())
    return signals, clocks


def toml_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def toml_key(k):
    return k if BARE_KEY.match(k) else toml_str(k)


def description(sig):
    desc = ": ".join(p for p in (sig["section"], sig["comment"]) if p)
    if sig["other"]:
        other = ", ".join(f"{k} {v}" for k, v in sig["other"].items())
        desc = "; ".join(p for p in (desc, f"XDC also sets {other}") if p)
    return desc


def render(signals, clocks, aliases, xdc_name):
    out = [
        "[signals]",
        f"# Generated from {xdc_name} by scripts/gen_digilent_board.py. Edit only",
        "# `aliases` by hand; the script keeps them and regenerates everything else.",
    ]
    for s in signals:
        fields = [f"pin = {toml_str(s['pin'])}"]
        if s["io_standard"]:
            fields.append(f"io_standard = {toml_str(s['io_standard'])}")
        if s["port"] in clocks:
            fields.append("clock = true")
        if aliases.get(s["port"]):
            fields.append(
                "aliases = [" + ", ".join(toml_str(a) for a in aliases[s["port"]]) + "]"
            )
        desc = description(s)
        if desc:
            fields.append(f"description = {toml_str(desc)}")
        out.append(f"{toml_key(s['port'])} = {{ " + ", ".join(fields) + " }")
    return "\n".join(out) + "\n"


def parse_pkg(text):
    """AMD package file: pin -> (name, bank, io_type)."""
    pins = {}
    for line in text.splitlines():
        cols = line.split()
        if len(cols) >= 8 and re.fullmatch(r"[A-Z]+[0-9]+", cols[0]):
            pins[cols[0]] = (cols[1], cols[3], cols[6])
    return pins


def check_pkg(signals, pkg):
    errors = []
    per_bank = defaultdict(list)
    by_pin = defaultdict(list)
    for s in signals:
        info = pkg.get(s["pin"].upper())
        if info is None:
            errors.append(f"{s['port']}: pin {s['pin']} is not in the package file")
            continue
        name, bank, _ = info
        if not name.startswith("IO_"):
            errors.append(f"{s['port']}: pin {s['pin']} is {name}, not a user IO")
            continue
        if s["comment"] and s["comment"].split()[0].startswith("IO_"):
            if s["comment"].split()[0] != name:
                errors.append(
                    f"{s['port']}: XDC comment says {s['comment'].split()[0]}, "
                    f"package file says {name}"
                )
        per_bank[bank].append(s["port"])
        by_pin[s["pin"].upper()].append(s["port"])

    print("Signals per bank:")
    for bank in sorted(per_bank, key=int):
        print(f"  bank {bank}: {len(per_bank[bank])}")
    shared = {p: ports for p, ports in by_pin.items() if len(ports) > 1}
    if shared:
        print("Pins used by more than one XDC port:")
        for p, ports in sorted(shared.items()):
            print(f"  {p}: {', '.join(ports)}")

    # True differential pairs: IO_L<n>P_<...>_<bank> and IO_L<n>N_<...>_<bank>.
    pair_re = re.compile(r"^IO_L(\d+)([PN])_.*_(\d+)$")
    legs = {}
    for pin in by_pin:
        m = pair_re.match(pkg[pin][0])
        if m:
            legs[(m.group(1), m.group(3), m.group(2))] = pin
    print("Differential pairs (P / N) among the signals:")
    for (n, bank, side), p in sorted(legs.items(), key=lambda kv: (int(kv[0][1]), int(kv[0][0]))):
        if side != "P" or (n, bank, "N") not in legs:
            continue
        q = legs[(n, bank, "N")]
        print(
            f"  bank {bank} L{n}: {p} {pkg[p][0]} ({', '.join(by_pin[p])}) / "
            f"{q} {pkg[q][0]} ({', '.join(by_pin[q])})"
        )
    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("board")
    ap.add_argument("xdc")
    ap.add_argument("--pkg", help="AMD package pinout file to cross-check against")
    ap.add_argument("--check", action="store_true", help="don't write; fail on diff")
    args = ap.parse_args()

    with open(args.xdc, encoding="utf-8") as f:
        signals, clocks = parse_xdc(f.read())
    ports = [s["port"] for s in signals]
    dups = sorted({p for p in ports if ports.count(p) > 1})
    if dups:
        sys.exit(f"duplicate XDC ports: {', '.join(dups)}")
    missing_clocks = clocks - set(ports)
    if missing_clocks:
        sys.exit(f"create_clock on unknown ports: {', '.join(sorted(missing_clocks))}")

    with open(args.board, encoding="utf-8") as f:
        board_text = f.read()
    existing = tomllib.loads(board_text).get("signals", {})
    aliases = {k: v.get("aliases", []) for k, v in existing.items()}
    stale = sorted(k for k, a in aliases.items() if a and k not in ports)
    if stale:
        sys.exit(f"aliases on signals not in the XDC: {', '.join(stale)}")

    m = re.search(r"^\[signals\]\s*$", board_text, re.M)
    header = board_text[: m.start()] if m else board_text.rstrip("\n") + "\n\n"
    new_text = header + render(signals, clocks, aliases, args.xdc.rsplit("/", 1)[-1])
    tomllib.loads(new_text)

    errors = []
    if args.pkg:
        with open(args.pkg, encoding="utf-8") as f:
            errors = check_pkg(signals, parse_pkg(f.read()))
    print(f"{len(signals)} signals, clocks: {', '.join(sorted(clocks)) or 'none'}")

    if args.check:
        if new_text != board_text:
            errors.append(f"{args.board} is out of date")
    elif new_text != board_text:
        with open(args.board, "w", encoding="utf-8") as f:
            f.write(new_text)
        print(f"wrote {args.board}")

    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
