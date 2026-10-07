//! Board-level rule checks against the real builtin board data.
//!
//! Every pin, signal and bank below comes from `boards/`:
//! - Basys 3 (`basys3.toml`, `devices/xc7a35t-cpg236.toml`): all banks at 3.3 V.
//! - Arty A7-35 (`arty-a7-35.toml`, `devices/xc7a35t-csg324.toml`): banks 14, 15,
//!   16 and 35 at 3.3 V, bank 34 at 1.35 V; every IO bank is HR.
//! - iCEBreaker (`icebreaker.toml`, `devices/ice40up5k-sg48.toml`): PCF target.

use bitstream_boards::Database;
use bitstream_manifest::{Diagnostic, Manifest, Severity};
use bitstream_rules::{Report, ResolvedPort};

/// A manifest for `board` with `pins` as the body of its `[pins]` table.
fn manifest(board: &str, pins: &str) -> String {
    format!("[project]\nname = \"t\"\ntop = \"top\"\nboard = \"{board}\"\n\n[pins]\n{pins}")
}

struct Checked {
    src: String,
    report: Report<'static>,
}

/// Parse `src` (which must be structurally valid) and run the board checks.
fn check(src: impl Into<String>) -> Checked {
    let src = src.into();
    let (m, warnings) = Manifest::parse(&src).unwrap_or_else(|e| {
        let r: Vec<String> = e.iter().map(|d| d.render("bitstream.toml", &src)).collect();
        panic!("manifest does not parse:\n{}", r.join("\n"))
    });
    assert!(
        warnings.is_empty(),
        "unexpected parse warnings: {warnings:?}"
    );
    let report = bitstream_rules::check(&m, Database::builtin());
    Checked { src, report }
}

fn check_pins(board: &str, pins: &str) -> Checked {
    check(manifest(board, pins))
}

impl Checked {
    fn diags(&self) -> &[Diagnostic] {
        &self.report.diagnostics
    }

    fn rendered(&self) -> String {
        self.diags()
            .iter()
            .map(|d| d.render("bitstream.toml", &self.src))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn codes(&self) -> Vec<&'static str> {
        self.diags().iter().map(|d| d.code).collect()
    }

    fn ports(&self) -> &[ResolvedPort] {
        &self.report.ports
    }

    fn assert_clean(&self) {
        assert!(
            self.diags().is_empty(),
            "expected no diagnostics, got:\n{}",
            self.rendered()
        );
    }

    fn assert_no(&self, code: &str) {
        assert!(
            !self.codes().contains(&code),
            "expected no `{code}`, got:\n{}",
            self.rendered()
        );
    }

    fn all(&self, code: &str) -> Vec<&Diagnostic> {
        self.diags().iter().filter(|d| d.code == code).collect()
    }

    /// The single diagnostic with `code`.
    fn one(&self, code: &str) -> &Diagnostic {
        let found = self.all(code);
        assert_eq!(
            found.len(),
            1,
            "expected exactly one `{code}`, got:\n{}",
            self.rendered()
        );
        found[0]
    }

    /// Source text under a span.
    fn text(&self, span: &std::ops::Range<usize>) -> &str {
        &self.src[span.clone()]
    }

    /// Source text under the primary label.
    fn primary(&self, d: &Diagnostic) -> &str {
        let p = d.primary.as_ref().expect("diagnostic has a primary span");
        self.text(&p.span)
    }

    /// Source text under each secondary label.
    fn secondaries(&self, d: &Diagnostic) -> Vec<&str> {
        d.secondary.iter().map(|l| self.text(&l.span)).collect()
    }

    /// Assert one `code` diagnostic with `severity`, whose primary span covers
    /// `primary` and whose message contains `message`. Returns it.
    fn expect(&self, code: &str, severity: Severity, primary: &str, message: &str) -> &Diagnostic {
        let d = self.one(code);
        let r = self.rendered();
        assert_eq!(d.severity, severity, "{r}");
        assert_eq!(self.primary(d), primary, "{r}");
        assert!(
            d.message.contains(message),
            "message {:?} lacks {message:?}\n{r}",
            d.message
        );
        d
    }
}

fn help(d: &Diagnostic) -> &str {
    d.help.as_deref().unwrap_or_default()
}

// ---------------------------------------------------------------- unknown-board

#[test]
fn unknown_board_passes_for_known_boards() {
    for board in ["basys3", "arty-a7-35", "icebreaker"] {
        let c = check(manifest(board, ""));
        c.assert_clean();
        assert!(c.report.target.is_some());
    }
}

#[test]
fn unknown_board_typo_suggests_close_id() {
    let c = check(manifest("basys", "led = { signal = \"LD0\" }\n"));
    let d = c.expect(
        "unknown-board",
        Severity::Error,
        "\"basys\"",
        "unknown board `basys`",
    );
    assert_eq!(help(d), "did you mean `basys3`?");
    // No pin checks run without a board.
    assert_eq!(c.codes(), ["unknown-board"]);
    assert!(c.report.target.is_none() && c.ports().is_empty());
}

#[test]
fn unknown_board_lists_known_boards() {
    let c = check(manifest("de10-nano", ""));
    let d = c.expect(
        "unknown-board",
        Severity::Error,
        "\"de10-nano\"",
        "de10-nano",
    );
    assert!(help(d).starts_with("known boards: "), "{}", help(d));
    for id in ["arty-a7-35", "basys3", "icebreaker"] {
        assert!(help(d).contains(id), "{}", help(d));
    }
}

// ---------------------------------------------------------------- part-mismatch

fn with_part(board: &str, part: &str) -> String {
    manifest(board, "").replace(
        &format!("board = \"{board}\"\n"),
        &format!("board = \"{board}\"\npart = \"{part}\"\n"),
    )
}

#[test]
fn part_mismatch_passes_for_another_speed_grade() {
    // Arty default is xc7a35ticsg324-1L; same device and package, other grade.
    check(with_part("arty-a7-35", "xc7a35tcsg324-1")).assert_clean();
    check(with_part("basys3", "XC7A35TCPG236-3")).assert_clean();
}

#[test]
fn part_mismatch_other_package() {
    let c = check(with_part("arty-a7-35", "xc7a35tcpg236-1"));
    let d = c.expect(
        "part-mismatch",
        Severity::Error,
        "\"xc7a35tcpg236-1\"",
        "is not a xc7a35t in the csg324 package",
    );
    assert!(help(d).contains("xc7a35ticsg324-1L"), "{}", help(d));
}

#[test]
fn part_mismatch_other_device() {
    let c = check(with_part("basys3", "xc7a100tcpg236-1"));
    c.expect(
        "part-mismatch",
        Severity::Error,
        "\"xc7a100tcpg236-1\"",
        "xc7a35t",
    );
}

// ---------------------------------------------------------------- unknown-signal

#[test]
fn unknown_signal_passes_for_names_and_aliases() {
    let c = check_pins(
        "arty-a7-35",
        "clk = { signal = \"CLK100MHZ\" }\nled = { signal = \"LD4\" }\n",
    );
    c.assert_clean();
    let led = c.ports().iter().find(|p| p.port == "led").unwrap();
    assert_eq!(led.signal.as_deref(), Some("led[0]"));
    assert_eq!(led.pin, "H5");
}

#[test]
fn unknown_signal_typo_suggests_close_name() {
    let c = check_pins("arty-a7-35", "clk = { signal = \"CLK100MZ\" }\n");
    let d = c.expect(
        "unknown-signal",
        Severity::Error,
        "\"CLK100MZ\"",
        "`CLK100MZ` is not a signal on the Digilent Arty A7-35",
    );
    assert_eq!(help(d), "did you mean `CLK100MHZ`?");
    assert!(c.ports().is_empty());
}

#[test]
fn package_pin_given_as_signal_suggests_pin() {
    // W5 is the Basys 3 clock pin; it is one edit away from the alias SW5, but an
    // exact package pin match is the better hint.
    let c = check_pins("basys3", "clk = { signal = \"W5\" }\n");
    let d = c.expect("unknown-signal", Severity::Error, "\"W5\"", "`W5`");
    assert_eq!(
        help(d),
        "`W5` is a package pin; use `pin = \"W5\"` instead of `signal`"
    );
}

#[test]
fn unknown_signal_far_from_everything_points_at_board_file() {
    let c = check_pins("basys3", "x = { signal = \"hdmi_tx_clk_p\" }\n");
    let d = c.expect(
        "unknown-signal",
        Severity::Error,
        "\"hdmi_tx_clk_p\"",
        "hdmi_tx_clk_p",
    );
    assert!(help(d).contains("boards/basys3.toml"), "{}", help(d));
}

#[test]
fn unknown_signal_in_a_bus_points_at_the_element() {
    let c = check_pins(
        "basys3",
        "led = { signals = [\"LD0\", \"LD99\", \"LD2\"] }\n",
    );
    c.expect("unknown-signal", Severity::Error, "\"LD99\"", "LD99");
    let ports: Vec<&str> = c.ports().iter().map(|p| p.port.as_str()).collect();
    assert_eq!(ports, ["led[0]", "led[2]"]);
}

#[test]
fn signal_name_given_as_pin_suggests_signal() {
    let c = check_pins("arty-a7-35", "clk = { pin = \"CLK100MHZ\" }\n");
    let d = c.expect(
        "unknown-pin",
        Severity::Error,
        "\"CLK100MHZ\"",
        "package pin `CLK100MHZ` does not exist on xc7a35t-csg324",
    );
    assert_eq!(
        help(d),
        "`CLK100MHZ` is a board signal; use `signal = \"CLK100MHZ\"` instead of `pin`"
    );
}

// ---------------------------------------------------------------- unknown-pin

#[test]
fn unknown_pin_passes_for_package_pins() {
    // Lower case is accepted and normalised to the pinout's spelling.
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"g13\", io_standard = \"LVCMOS33\" }\n",
    );
    c.assert_clean();
    assert_eq!(c.ports()[0].pin, "G13");
    check_pins("icebreaker", "a = { pin = \"4\" }\n").assert_clean();
}

#[test]
fn unknown_pin_xilinx() {
    let c = check_pins(
        "basys3",
        "a = { pin = \"Z99\", io_standard = \"LVCMOS33\" }\n",
    );
    c.expect(
        "unknown-pin",
        Severity::Error,
        "\"Z99\"",
        "package pin `Z99` does not exist on xc7a35t-cpg236",
    );
    assert!(c.ports().is_empty());
}

#[test]
fn unknown_pin_ice40() {
    // The SG48 package has pins 1..48 (plus the paddle).
    let c = check_pins("icebreaker", "a = { pin = \"49\" }\n");
    c.expect("unknown-pin", Severity::Error, "\"49\"", "ice40up5k-sg48");
}

#[test]
fn unknown_pin_n() {
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"E15\", pin_n = \"E99\", io_standard = \"TMDS_33\" }\n",
    );
    c.expect("unknown-pin", Severity::Error, "\"E99\"", "E99");
}

// ---------------------------------------------------------------- unknown-io-standard

#[test]
fn unknown_io_standard_passes() {
    check_pins(
        "basys3",
        "a = { signal = \"sw[0]\", io_standard = \"LVCMOS33\" }\n\
         b = { signal = \"sw[1]\", io_standard = \"lvttl\" }\n",
    )
    .assert_clean();
}

#[test]
fn unknown_io_standard_typo() {
    let c = check_pins(
        "basys3",
        "a = { signal = \"sw[0]\", io_standard = \"LVCMOS3\" }\n",
    );
    let d = c.expect(
        "unknown-io-standard",
        Severity::Error,
        "\"LVCMOS3\"",
        "`LVCMOS3` is not an IO standard of the AMD 7 series",
    );
    assert_eq!(help(d), "did you mean `LVCMOS33`?");
}

#[test]
fn unknown_io_standard_ice40() {
    // iCE40 has no differential IO standard in the family data.
    let c = check_pins(
        "icebreaker",
        "a = { signal = \"P1A1\", io_standard = \"LVDS_25\" }\n",
    );
    c.expect(
        "unknown-io-standard",
        Severity::Error,
        "\"LVDS_25\"",
        "Lattice iCE40",
    );
}

// ---------------------------------------------------------------- bank-voltage

#[test]
fn bank_voltage_passes_at_3v3() {
    // jb[0] is E15 (IO_L11P_T1_SRCC_15), bank 15 at 3.3 V; TMDS_33 is differential.
    check_pins(
        "arty-a7-35",
        "a = { signal = \"ja[0]\", io_standard = \"LVCMOS33\" }\n\
         b = { signal = \"jb[0]\", io_standard = \"TMDS_33\" }\n",
    )
    .assert_clean();
}

#[test]
fn bank_voltage_lvds_25_on_3v3_bank() {
    let c = check_pins(
        "arty-a7-35",
        "lvds = { signal = \"jb[0]\", io_standard = \"LVDS_25\" }\n",
    );
    let d = c.expect(
        "bank-voltage",
        Severity::Error,
        "\"LVDS_25\"",
        "LVDS_25 needs VCCO = 2.5 V, but bank 15 is powered at 3.3 V",
    );
    assert_eq!(c.secondaries(d), ["\"jb[0]\""]);
    assert_eq!(d.secondary[0].message, "pin E15 is in bank 15 (3.3 V)");
    assert!(help(d).contains("TMDS_33"), "{}", help(d));
    assert!(help(d).contains("no bank powered at 2.5 V"), "{}", help(d));
    assert_eq!(c.codes(), ["bank-voltage"]);
}

#[test]
fn bank_voltage_lvds_25_input_without_termination_is_a_warning() {
    let c = check_pins(
        "arty-a7-35",
        "lvds = { signal = \"jb[0]\", io_standard = \"LVDS_25\", diff_term = false }\n",
    );
    let d = c.expect("bank-voltage", Severity::Warning, "\"LVDS_25\"", "LVDS_25");
    assert!(
        d.notes
            .iter()
            .any(|n| n.contains("without internal termination")),
        "{:?}",
        d.notes
    );
    assert!(!c.report.has_errors());
}

#[test]
fn bank_voltage_lvds_25_with_termination_is_an_error() {
    let c = check_pins(
        "arty-a7-35",
        "lvds = { signal = \"jb[0]\", io_standard = \"LVDS_25\", diff_term = true }\n",
    );
    c.expect("bank-voltage", Severity::Error, "\"LVDS_25\"", "LVDS_25");
}

#[test]
fn bank_voltage_lvcmos18_on_3v3_bank() {
    let c = check_pins(
        "basys3",
        "a = { signal = \"sw[0]\", io_standard = \"LVCMOS18\" }\n",
    );
    let d = c.expect(
        "bank-voltage",
        Severity::Error,
        "\"LVCMOS18\"",
        "LVCMOS18 needs VCCO = 1.8 V, but bank 14 is powered at 3.3 V",
    );
    assert!(help(d).contains("LVCMOS33"), "{}", help(d));
    assert!(help(d).contains("no bank powered at 1.8 V"), "{}", help(d));
}

#[test]
fn bank_voltage_lvcmos33_on_1v35_bank() {
    // L1 is IO_L1P_T0_34; the Arty's bank 34 feeds the DDR3L at 1.35 V.
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"L1\", io_standard = \"LVCMOS33\" }\n",
    );
    let d = c.expect(
        "bank-voltage",
        Severity::Error,
        "\"LVCMOS33\"",
        "bank 34 is powered at 1.35 V",
    );
    assert_eq!(c.secondaries(d), ["\"L1\""]);
    // Bank 0 is also at 3.3 V but holds only configuration pins on the CSG324.
    assert_eq!(
        help(d),
        "no IO standard works at 1.35 V in this bank; or move the port to bank 14/15/16/35 (3.3 V)"
    );
}

#[test]
fn bank_voltage_ice40() {
    // Every iCEBreaker bank is at 3.3 V.
    check_pins(
        "icebreaker",
        "a = { signal = \"P1A1\", io_standard = \"LVCMOS33\" }\n",
    )
    .assert_clean();
    let c = check_pins(
        "icebreaker",
        "a = { signal = \"P1A1\", io_standard = \"LVCMOS18\" }\n",
    );
    c.expect(
        "bank-voltage",
        Severity::Error,
        "\"LVCMOS18\"",
        "bank 2 is powered at 3.3 V",
    );
}

// ---------------------------------------------------------------- bank-type

#[test]
fn bank_type_passes_for_hr_standards() {
    check_pins(
        "arty-a7-35",
        "a = { pin = \"G13\", io_standard = \"LVTTL\" }\n",
    )
    .assert_clean();
}

#[test]
fn bank_type_hp_only_lvds_on_hr_bank() {
    // LVDS (not LVDS_25) is HP-only; the Artix-7 has only HR banks.
    let c = check_pins(
        "arty-a7-35",
        "lvds = { pin = \"E15\", io_standard = \"LVDS\" }\n",
    );
    let d = c.expect(
        "bank-type",
        Severity::Error,
        "\"LVDS\"",
        "LVDS is not supported in HR banks",
    );
    assert_eq!(d.primary.as_ref().unwrap().message, "needs a HP bank");
    assert_eq!(c.secondaries(d), ["\"E15\""]);
    assert_eq!(d.secondary[0].message, "pin E15 is in HR bank 15");
    // LVDS also needs 1.8 V.
    c.one("bank-voltage");
}

#[test]
fn bank_type_hp_only_sstl12_on_hr_bank() {
    let c = check_pins(
        "basys3",
        "a = { signal = \"sw[0]\", io_standard = \"SSTL12\" }\n",
    );
    c.expect(
        "bank-type",
        Severity::Error,
        "\"SSTL12\"",
        "SSTL12 is not supported in HR banks",
    );
}

// ---------------------------------------------------------------- missing-io-standard

#[test]
fn missing_io_standard_passes_with_explicit_or_board_standard() {
    check_pins(
        "basys3",
        "a = { pin = \"W5\", io_standard = \"LVCMOS33\" }\nb = { signal = \"sw[0]\" }\n",
    )
    .assert_clean();
}

#[test]
fn missing_io_standard_raw_xilinx_pin() {
    let c = check_pins("arty-a7-35", "a = { pin = \"G13\" }\n");
    let d = c.expect(
        "missing-io-standard",
        Severity::Warning,
        "\"G13\"",
        "port `a` has no IO standard",
    );
    assert!(
        d.notes.iter().any(|n| n.contains("NSTD-1")),
        "{:?}",
        d.notes
    );
    assert_eq!(c.codes(), ["missing-io-standard"]);
}

#[test]
fn missing_io_standard_not_needed_on_ice40() {
    // Raw pin, and the RGB LED signal which has no standard in the board data.
    check_pins(
        "icebreaker",
        "a = { pin = \"4\" }\nb = { signal = \"LED_RED_N\" }\n",
    )
    .assert_clean();
}

// ---------------------------------------------------------------- diff-pair

#[test]
fn diff_pair_p_leg_passes() {
    // E15/E16 are IO_L11P/N_T1_SRCC_15.
    check_pins(
        "arty-a7-35",
        "a = { pin = \"E15\", io_standard = \"TMDS_33\" }\n\
         b = { pin = \"H16\", pin_n = \"G16\", io_standard = \"TMDS_33\" }\n\
         c = { signal = \"jb[2]\", signal_n = \"jb[3]\", io_standard = \"TMDS_33\" }\n",
    )
    .assert_clean();
}

#[test]
fn diff_pair_n_leg_as_pin() {
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"E16\", io_standard = \"TMDS_33\" }\n",
    );
    let d = c.expect(
        "diff-pair",
        Severity::Error,
        "\"E16\"",
        "pin E16 is the negative leg of its pair",
    );
    assert!(help(d).contains("positive leg `E15`"), "{}", help(d));
}

#[test]
fn diff_pair_pin_without_partner() {
    // G13 is IO_0_15, which has no pair.
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"G13\", io_standard = \"TMDS_33\" }\n",
    );
    let d = c.expect(
        "diff-pair",
        Severity::Error,
        "\"G13\"",
        "pin G13 is not part of a differential pair",
    );
    assert_eq!(
        d.primary.as_ref().unwrap().message,
        "IO_0_15 has no partner pin"
    );
    assert_eq!(c.codes(), ["diff-pair"]);
}

#[test]
fn diff_pair_unbonded_partner_basys3() {
    // led[15] is L1, IO_L6N_T0_VREF_35, whose P leg is not bonded out in the CPG236.
    let c = check_pins(
        "basys3",
        "a = { signal = \"led[15]\", io_standard = \"TMDS_33\" }\n",
    );
    c.expect(
        "diff-pair",
        Severity::Error,
        "\"led[15]\"",
        "pin L1 is not part of a differential pair",
    );
}

#[test]
fn diff_pair_wrong_pin_n() {
    // C15 is the N leg of D15, not of E15.
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"E15\", pin_n = \"C15\", io_standard = \"TMDS_33\" }\n",
    );
    let d = c.expect(
        "diff-pair",
        Severity::Error,
        "\"C15\"",
        "pins E15 and C15 are not a differential pair",
    );
    assert_eq!(c.secondaries(d), ["\"E15\""]);
    assert_eq!(help(d), "the negative leg of E15 is E16");
}

#[test]
fn diff_pair_pin_n_with_single_ended_standard() {
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"E15\", pin_n = \"E16\", io_standard = \"LVCMOS33\" }\n",
    );
    let d = c.expect(
        "diff-pair",
        Severity::Error,
        "\"E16\"",
        "port `a` has a negative leg but a single-ended IO standard",
    );
    assert_eq!(c.secondaries(d), ["\"LVCMOS33\""]);
}

#[test]
fn diff_pair_signal_n_with_board_standard() {
    // jb[0]/jb[1] default to LVCMOS33 from the board.
    let c = check_pins(
        "arty-a7-35",
        "a = { signal = \"jb[0]\", signal_n = \"jb[1]\" }\n",
    );
    let d = c.expect(
        "diff-pair",
        Severity::Error,
        "\"jb[1]\"",
        "single-ended IO standard",
    );
    assert!(
        help(d).contains("set a differential `io_standard`"),
        "{}",
        help(d)
    );
}

// ---------------------------------------------------------------- clock-pin

#[test]
fn clock_pin_passes_on_clock_capable_pins() {
    check_pins(
        "arty-a7-35",
        "clk = { signal = \"CLK100MHZ\" }\n\
         clk2 = { pin = \"F15\", io_standard = \"LVCMOS33\", clock = true }\n\
         clk3 = { signal = \"jb[2]\", clock = true }\n",
    )
    .assert_clean();
    check_pins("basys3", "clk = { signal = \"clk\", clock = true }\n").assert_clean();
}

#[test]
fn clock_pin_on_gpio_signal() {
    // ja[0] is G13, IO_0_15.
    let c = check_pins("arty-a7-35", "clk = { signal = \"ja[0]\", clock = true }\n");
    let d = c.expect(
        "clock-pin",
        Severity::Error,
        "\"ja[0]\"",
        "clock port `clk` is on pin G13, which is not clock-capable",
    );
    assert_eq!(c.secondaries(d), ["true"]);
    assert!(help(d).contains("in the same bank"), "{}", help(d));
}

#[test]
fn clock_pin_board_clock_moved_to_gpio() {
    // The design's 100 MHz clock port moved by hand from E3 to K16 (IO_25_15).
    let c = check_pins(
        "arty-a7-35",
        "CLK100MHZ = { pin = \"K16\", io_standard = \"LVCMOS33\", clock = true }\n",
    );
    let d = c.expect("clock-pin", Severity::Error, "\"K16\"", "pin K16");
    assert_eq!(
        d.primary.as_ref().unwrap().message,
        "IO_25_15 is a general-purpose IO"
    );
    assert_eq!(c.secondaries(d), ["true"]);
}

#[test]
fn clock_pin_ice40() {
    // Pin 35 (IOT_46b_G0) is GBIN; pin 4 (IOB_8a) is not.
    check_pins("icebreaker", "clk = { pin = \"35\", clock = true }\n").assert_clean();
    let c = check_pins("icebreaker", "clk = { pin = \"4\", clock = true }\n");
    c.expect("clock-pin", Severity::Error, "\"4\"", "not clock-capable");
}

#[test]
fn every_board_clock_signal_is_on_a_clock_capable_pin() {
    let db = Database::builtin();
    for board in db.boards() {
        let target = db.target(&board.id).unwrap();
        let clocks: Vec<&String> = board
            .signals
            .iter()
            .filter(|(_, s)| s.clock)
            .map(|(name, _)| name)
            .collect();
        assert!(!clocks.is_empty(), "{} has no clock signal", board.id);
        for name in clocks {
            let c = check_pins(&board.id, &format!("clk = {{ signal = \"{name}\" }}\n"));
            c.assert_clean();
            let port = &c.ports()[0];
            assert!(port.clock, "{}: {name} is not marked as a clock", board.id);
            let pin = target.device.pin(&port.pin).unwrap();
            assert!(
                pin.clock.is_some(),
                "{}: {name} is on {} ({}), which is not clock-capable",
                board.id,
                pin.pin,
                pin.name
            );
        }
    }
}

// ---------------------------------------------------------------- not-user-io

#[test]
fn not_user_io_config_pin() {
    // P10 is DONE_0 on the CSG324.
    let c = check_pins("arty-a7-35", "a = { pin = \"P10\" }\n");
    let d = c.expect(
        "not-user-io",
        Severity::Error,
        "\"P10\"",
        "pin P10 (DONE_0) is a dedicated configuration pin",
    );
    assert_eq!(d.primary.as_ref().unwrap().message, "not a user IO pin");
}

#[test]
fn not_user_io_config_pin_basys3() {
    // U12 is DONE_0 on the CPG236 (and a Pmod pin on the Arty's CSG324).
    let c = check_pins(
        "basys3",
        "a = { pin = \"U12\", io_standard = \"LVCMOS33\" }\n",
    );
    c.expect("not-user-io", Severity::Error, "\"U12\"", "DONE_0");
    check_pins("arty-a7-35", "a = { signal = \"jc[0]\" }\n").assert_clean();
}

#[test]
fn not_user_io_power_pin() {
    // N9 is VCCINT on the CSG324.
    let c = check_pins("arty-a7-35", "a = { pin = \"N9\" }\n");
    c.expect(
        "not-user-io",
        Severity::Error,
        "\"N9\"",
        "pin N9 (VCCINT) is a power pin",
    );
}

#[test]
fn not_user_io_ice40_cdone() {
    // Pin 7 is CDONE.
    let c = check_pins("icebreaker", "a = { pin = \"7\" }\n");
    c.expect("not-user-io", Severity::Error, "\"7\"", "CDONE");
}

#[test]
fn not_user_io_pin_n() {
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"E15\", pin_n = \"P10\", io_standard = \"TMDS_33\" }\n",
    );
    c.expect("not-user-io", Severity::Error, "\"P10\"", "DONE_0");
}

// ---------------------------------------------------------------- dual-purpose-pin

#[test]
fn dual_purpose_pin_through_board_signal_passes() {
    // qspi_cs is L13 (IO_L6P_T0_FCS_B_14); the board wires it to the flash.
    check_pins("arty-a7-35", "cs = { signal = \"qspi_cs\" }\n").assert_clean();
    // FLASH_IO0 is pin 14, IOB_32a_SPI_SO.
    check_pins("icebreaker", "so = { signal = \"FLASH_IO0\" }\n").assert_clean();
}

#[test]
fn dual_purpose_pin_raw() {
    let c = check_pins(
        "arty-a7-35",
        "cs = { pin = \"L13\", io_standard = \"LVCMOS33\" }\n",
    );
    let d = c.expect(
        "dual-purpose-pin",
        Severity::Warning,
        "\"L13\"",
        "pin L13 (IO_L6P_T0_FCS_B_14) is shared with configuration function FCS_B",
    );
    assert!(!d.notes.is_empty());
    assert!(!c.report.has_errors());
}

#[test]
fn dual_purpose_pin_raw_lists_every_function() {
    // D18 is IO_L1P_T0_D00_MOSI_14 on the CPG236.
    let c = check_pins(
        "basys3",
        "a = { pin = \"D18\", io_standard = \"LVCMOS33\" }\n",
    );
    c.expect("dual-purpose-pin", Severity::Warning, "\"D18\"", "D00/MOSI");
}

#[test]
fn dual_purpose_pin_raw_ice40() {
    let c = check_pins("icebreaker", "so = { pin = \"14\" }\n");
    c.expect("dual-purpose-pin", Severity::Warning, "\"14\"", "SPI_SO");
}

#[test]
fn dual_purpose_pin_n_leg() {
    // L13 (IO_L6P_T0_FCS_B_14) pairs with M13 (IO_L6N_T0_D08_VREF_14), which is the
    // board signal ck_io28. Through board signals neither leg warns.
    check_pins(
        "arty-a7-35",
        "a = { signal = \"qspi_cs\", signal_n = \"ck_io28\", io_standard = \"TMDS_33\" }\n",
    )
    .assert_clean();
    // As raw pins both legs do.
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"L13\", pin_n = \"M13\", io_standard = \"TMDS_33\" }\n",
    );
    let found: Vec<&str> = c
        .all("dual-purpose-pin")
        .into_iter()
        .map(|d| c.primary(d))
        .collect();
    assert_eq!(found, ["\"L13\"", "\"M13\""], "{}", c.rendered());
}

// ---------------------------------------------------------------- duplicate-pin

#[test]
fn duplicate_pin_passes_for_distinct_pins() {
    check_pins(
        "basys3",
        "led = { signals = [\"LD0\", \"LD1\"] }\nsw = { signals = [\"SW0\", \"SW1\"] }\n",
    )
    .assert_clean();
}

#[test]
fn duplicate_pin_signal_and_raw_pin() {
    // ja[0] is G13.
    let c = check_pins(
        "arty-a7-35",
        "a = { signal = \"ja[0]\" }\nb = { pin = \"G13\", io_standard = \"LVCMOS33\" }\n",
    );
    let d = c.expect(
        "duplicate-pin",
        Severity::Error,
        "\"G13\"",
        "pin G13 is assigned to both `a` and `b`",
    );
    assert_eq!(c.secondaries(d), ["\"ja[0]\""]);
    assert_eq!(d.primary.as_ref().unwrap().message, "`b` uses G13");
    assert_eq!(d.secondary[0].message, "`a` uses G13");
}

#[test]
fn duplicate_pin_signal_alias_and_name() {
    let c = check_pins(
        "basys3",
        "a = { signal = \"led[0]\" }\nb = { signal = \"LD0\" }\n",
    );
    c.expect("duplicate-pin", Severity::Error, "\"LD0\"", "pin U16");
}

#[test]
fn duplicate_pin_within_a_bus() {
    let c = check_pins("basys3", "led = { signals = [\"LD0\", \"led[0]\"] }\n");
    let d = c.expect(
        "duplicate-pin",
        Severity::Error,
        "\"led[0]\"",
        "pin U16 is assigned to both `led[0]` and `led[1]`",
    );
    assert_eq!(c.secondaries(d), ["\"LD0\""]);
}

#[test]
fn duplicate_pin_implied_n_leg() {
    // `a` on E15 with TMDS_33 also occupies E16, which is jb[1].
    let c = check_pins(
        "arty-a7-35",
        "a = { signal = \"jb[0]\", io_standard = \"TMDS_33\" }\nb = { signal = \"jb[1]\" }\n",
    );
    let d = c.expect(
        "duplicate-pin",
        Severity::Error,
        "\"jb[1]\"",
        "pin E16 is assigned to both `a` and `b`",
    );
    assert_eq!(c.secondaries(d), ["\"jb[0]\""]);
}

#[test]
fn duplicate_pin_explicit_n_leg() {
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"E15\", pin_n = \"E16\", io_standard = \"TMDS_33\" }\n\
         b = { pin = \"E16\", io_standard = \"LVCMOS33\" }\n",
    );
    let d = c.one("duplicate-pin");
    assert_eq!(c.primary(d), "\"E16\"");
    assert!(d.message.contains("`a` and `b`"), "{}", d.message);
    // The primary is b's pin, the secondary a's pin_n: both spell E16.
    assert!(d.primary.as_ref().unwrap().span.start > d.secondary[0].span.start);
    assert_eq!(c.secondaries(d), ["\"E16\""]);
}

// ---------------------------------------------------------------- vref-dci

#[test]
fn vref_dci_passes_for_non_dci_standards() {
    // SSTL135 needs VREF (not checked yet) but no DCI; bank 34 is at 1.35 V.
    check_pins(
        "arty-a7-35",
        "a = { pin = \"L1\", io_standard = \"SSTL135\" }\n",
    )
    .assert_clean();
}

#[test]
fn vref_dci_dci_standard_on_hr_bank() {
    // SSTL135_DCI on bank 34 (1.35 V): right voltage, but HR banks have no DCI.
    let c = check_pins(
        "arty-a7-35",
        "a = { pin = \"L1\", io_standard = \"SSTL135_DCI\" }\n",
    );
    let d = c.expect(
        "vref-dci",
        Severity::Error,
        "\"SSTL135_DCI\"",
        "SSTL135_DCI uses DCI, but bank 34 has no VRN/VRP reference pins",
    );
    assert!(help(d).contains("non-DCI variant"), "{}", help(d));
    c.one("bank-type");
    c.assert_no("bank-voltage");
}

#[test]
fn vref_dci_lvdci_on_basys3() {
    let c = check_pins(
        "basys3",
        "a = { signal = \"sw[0]\", io_standard = \"LVDCI_18\" }\n",
    );
    c.expect("vref-dci", Severity::Error, "\"LVDCI_18\"", "bank 14");
}

// ---------------------------------------------------------------- unsupported-setting

#[test]
fn unsupported_setting_passes_for_pull_up() {
    check_pins(
        "icebreaker",
        "btn = { signal = \"BTN_N\", pull = \"up\" }\nled = { signal = \"LEDR_N\", pull = \"none\" }\n",
    )
    .assert_clean();
}

#[test]
fn unsupported_setting_slew_and_pull_down() {
    let c = check_pins(
        "icebreaker",
        "led = { signal = \"LEDR_N\", slew = \"fast\", pull = \"down\" }\n",
    );
    let d = c.expect(
        "unsupported-setting",
        Severity::Warning,
        "led",
        "port `led` sets a pull-down or keeper, `slew`, which the Lattice iCE40 toolchain ignores",
    );
    assert!(
        d.notes.iter().any(|n| n.contains("pull-up")),
        "{:?}",
        d.notes
    );
    assert!(!c.report.has_errors());
}

#[test]
fn unsupported_setting_drive() {
    let c = check_pins("icebreaker", "\"tx\" = { signal = \"TX\", drive = 8 }\n");
    c.expect(
        "unsupported-setting",
        Severity::Warning,
        "\"tx\"",
        "`drive`",
    );
}

#[test]
fn unsupported_setting_is_fine_on_xilinx() {
    check_pins(
        "basys3",
        "led = { signal = \"LD0\", slew = \"fast\", drive = 8, pull = \"down\" }\n",
    )
    .assert_clean();
}

// ---------------------------------------------------------------- buses

#[test]
fn bus_signals_expand_in_order() {
    let c = check_pins(
        "basys3",
        "led = { signals = [\"LD3\", \"led[1]\", \"LD0\"] }\n",
    );
    c.assert_clean();
    let got: Vec<(&str, &str, Option<&str>)> = c
        .ports()
        .iter()
        .map(|p| (p.port.as_str(), p.pin.as_str(), p.signal.as_deref()))
        .collect();
    assert_eq!(
        got,
        [
            ("led[0]", "V19", Some("led[3]")),
            ("led[1]", "E19", Some("led[1]")),
            ("led[2]", "U16", Some("led[0]")),
        ]
    );
    // Each bit's location span is its own list element.
    let spans: Vec<&str> = c.ports().iter().map(|p| c.text(&p.location_span)).collect();
    assert_eq!(spans, ["\"LD3\"", "\"led[1]\"", "\"LD0\""]);
}

#[test]
fn bus_pins_expand_in_order() {
    let c = check_pins(
        "arty-a7-35",
        "d = { pins = [\"G13\", \"K16\"], io_standard = \"LVCMOS33\" }\n",
    );
    c.assert_clean();
    let got: Vec<(&str, &str)> = c
        .ports()
        .iter()
        .map(|p| (p.port.as_str(), p.pin.as_str()))
        .collect();
    assert_eq!(got, [("d[0]", "G13"), ("d[1]", "K16")]);
}

#[test]
fn unsupported_setting_reported_once_per_bus() {
    let src = r#"
[project]
name = "t"
top = "t"
board = "icebreaker"

[pins]
leds = { signals = ["LEDR_N", "LEDG_N"], slew = "fast" }
"#;
    let (m, _) = bitstream_manifest::Manifest::parse(src).unwrap();
    let report = bitstream_rules::check(&m, bitstream_boards::Database::builtin());
    let n = report
        .diagnostics
        .iter()
        .filter(|d| d.code == "unsupported-setting")
        .count();
    assert_eq!(n, 1, "{:#?}", report.diagnostics);
}

#[test]
fn differential_port_on_n_leg_is_not_also_a_duplicate() {
    // E16 is the N leg of E15 on the Arty (IO_L11N_T1_SRCC_15).
    let src = r#"
[project]
name = "t"
top = "t"
board = "arty-a7-35"

[pins]
a = { pin = "E16", io_standard = "TMDS_33" }
b = { pin = "E15", io_standard = "LVCMOS33" }
"#;
    let (m, _) = bitstream_manifest::Manifest::parse(src).unwrap();
    let report = bitstream_rules::check(&m, bitstream_boards::Database::builtin());
    let codes: Vec<&str> = report.diagnostics.iter().map(|d| d.code).collect();
    assert_eq!(codes, ["diff-pair"], "{:#?}", report.diagnostics);
}

#[test]
fn clock_pin_rejects_n_leg_of_clock_capable_pair() {
    // D3 is IO_L12N_T1_MRCC_35 on the Arty; only its P leg E3 can take a
    // single-ended clock (UG472).
    let src = r#"
[project]
name = "t"
top = "t"
board = "arty-a7-35"

[pins]
clk = { pin = "D3", io_standard = "LVCMOS33", clock = true }
"#;
    let (m, _) = bitstream_manifest::Manifest::parse(src).unwrap();
    let report = bitstream_rules::check(&m, bitstream_boards::Database::builtin());
    let codes: Vec<&str> = report.diagnostics.iter().map(|d| d.code).collect();
    assert_eq!(codes, ["clock-pin"], "{:#?}", report.diagnostics);
    assert!(
        report.diagnostics[0]
            .help
            .as_deref()
            .is_some_and(|h| h.contains("E3")),
        "{:#?}",
        report.diagnostics
    );
}

#[test]
fn board_signal_pull_is_the_default() {
    // The Basys 3 master XDC sets PULLUP true on PS2Clk.
    let src = r#"
[project]
name = "t"
top = "t"
board = "basys3"

[pins]
ps2_clk = { signal = "PS2Clk" }
ps2_data = { signal = "PS2Data", pull = "none" }
"#;
    let (m, _) = bitstream_manifest::Manifest::parse(src).unwrap();
    let report = bitstream_rules::check(&m, bitstream_boards::Database::builtin());
    assert!(report.diagnostics.is_empty(), "{:#?}", report.diagnostics);
    let pull = |name: &str| report.ports.iter().find(|p| p.port == name).unwrap().pull;
    assert_eq!(pull("ps2_clk"), Some(bitstream_manifest::Pull::Up));
    assert_eq!(pull("ps2_data"), Some(bitstream_manifest::Pull::None));
}
