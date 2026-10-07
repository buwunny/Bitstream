//! Parse and validate `bitstream.toml`.
//!
//! [`Manifest::parse`] turns TOML into typed data while keeping byte spans for every
//! value that a later diagnostic may need to point at. Structural problems
//! (syntax errors, unknown keys, conflicting fields) come back as [`Diagnostic`]s
//! with spans, ready to render with [`Diagnostic::render`].

pub mod diagnostic;

use std::collections::BTreeMap;

use serde::Deserialize;
pub use toml::Spanned;

pub use diagnostic::{Diagnostic, Label, LineCol, Severity, Span, line_col};

/// The canonical manifest file name.
pub const MANIFEST_FILE: &str = "bitstream.toml";

/// A parsed `bitstream.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub project: Project,
    #[serde(default)]
    pub sources: Sources,
    #[serde(default)]
    pub constraints: Constraints,
    #[serde(default)]
    pub dependencies: BTreeMap<Spanned<String>, Spanned<Dependency>>,
    #[serde(default)]
    pub pins: BTreeMap<Spanned<String>, Spanned<PinAssignment>>,
    #[serde(default)]
    pub sim: Option<Sim>,
    #[serde(default)]
    pub build: Option<Build>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub name: Spanned<String>,
    #[serde(default)]
    pub version: Option<Spanned<String>>,
    /// Name of the top-level HDL module or entity.
    pub top: Spanned<String>,
    /// Board id, matching a file in the board database (for example `basys3`).
    pub board: Spanned<String>,
    /// Optional full part number that overrides the board's default, for example to
    /// pick another speed grade. Must use the same device and package as the board.
    #[serde(default)]
    pub part: Option<Spanned<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sources {
    /// HDL source files or glob patterns, relative to the manifest.
    #[serde(default)]
    pub files: Vec<Spanned<String>>,
    #[serde(default)]
    pub include_dirs: Vec<Spanned<String>>,
    /// Preprocessor defines (Verilog) or generics (VHDL) for the top module.
    #[serde(default)]
    pub defines: BTreeMap<String, Spanned<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Constraints {
    /// Native XDC/SDC/PCF files passed through to the vendor tool unchanged.
    #[serde(default)]
    pub files: Vec<Spanned<String>>,
}

/// A dependency on another HDL package.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Dependency {
    Git {
        git: String,
        #[serde(default)]
        rev: Option<String>,
        #[serde(default)]
        tag: Option<String>,
        #[serde(default)]
        branch: Option<String>,
        /// Path to a FuseSoC `.core` file inside the repository.
        #[serde(default)]
        core: Option<String>,
    },
    Path {
        path: String,
        #[serde(default)]
        core: Option<String>,
    },
    /// A FuseSoC CAPI2 `.core` file on disk.
    Core { core: String },
}

/// How one top-level port maps to the board.
///
/// Exactly one of `signal`, `signals`, `pin` or `pins` must be set. The plural forms
/// describe a bus: element `i` of the list drives `port[i]`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinAssignment {
    /// A named board signal, such as `CLK100MHZ` or `led[0]`.
    #[serde(default)]
    pub signal: Option<Spanned<String>>,
    #[serde(default)]
    pub signals: Option<Vec<Spanned<String>>>,
    /// A raw package pin, such as `W5` (Xilinx) or `35` (iCE40 SG48).
    #[serde(default)]
    pub pin: Option<Spanned<String>>,
    #[serde(default)]
    pub pins: Option<Vec<Spanned<String>>>,
    /// Negative leg of a differential pair, given as a board signal.
    #[serde(default)]
    pub signal_n: Option<Spanned<String>>,
    /// Negative leg of a differential pair, given as a package pin.
    #[serde(default)]
    pub pin_n: Option<Spanned<String>>,
    /// IO standard, for example `LVCMOS33` or `LVDS_25`. Defaults to the board
    /// signal's standard when one is defined.
    #[serde(default)]
    pub io_standard: Option<Spanned<String>>,
    /// The port carries a clock and must land on a clock-capable pin.
    #[serde(default)]
    pub clock: Option<Spanned<bool>>,
    #[serde(default)]
    pub pull: Option<Spanned<Pull>>,
    #[serde(default)]
    pub slew: Option<Spanned<Slew>>,
    /// Output drive strength in mA.
    #[serde(default)]
    pub drive: Option<Spanned<u32>>,
    /// Enable the internal differential termination (differential inputs only).
    #[serde(default)]
    pub diff_term: Option<Spanned<bool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pull {
    Up,
    Down,
    Keeper,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slew {
    Slow,
    Fast,
}

/// Simulation settings. Parsed now; executed in a later milestone.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sim {
    /// Defaults to Verilator for Verilog/SystemVerilog and NVC for VHDL.
    #[serde(default)]
    pub simulator: Option<Spanned<Simulator>>,
    /// Top-level module for simulation; defaults to `project.top`.
    #[serde(default)]
    pub toplevel: Option<Spanned<String>>,
    /// Extra HDL files used only in simulation.
    #[serde(default)]
    pub files: Vec<Spanned<String>>,
    /// Python modules containing cocotb tests.
    #[serde(default)]
    pub test_modules: Vec<Spanned<String>>,
    /// Write an FST waveform for each test.
    #[serde(default)]
    pub waves: Option<Spanned<bool>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Simulator {
    Verilator,
    Icarus,
    Nvc,
    Ghdl,
}

/// Build settings. Parsed now; executed in a later milestone.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Build {
    /// Defaults to the board family's toolchain.
    #[serde(default)]
    pub toolchain: Option<Spanned<Toolchain>>,
    /// Output directory, relative to the manifest. Defaults to `build`.
    #[serde(default)]
    pub out_dir: Option<Spanned<String>>,
    /// Directory containing the vendor tool binaries, if not on `PATH`.
    #[serde(default)]
    pub tool_path: Option<Spanned<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Toolchain {
    Vivado,
    YosysNextpnr,
}

impl Manifest {
    /// Parse and structurally validate a manifest.
    ///
    /// On success, returns the manifest plus any warnings. On failure, returns every
    /// error found (at least one).
    pub fn parse(source: &str) -> Result<(Manifest, Vec<Diagnostic>), Vec<Diagnostic>> {
        let manifest: Manifest = toml::from_str(source).map_err(|e| vec![toml_error(&e)])?;
        let diags = manifest.validate();
        if diags.iter().any(Diagnostic::is_error) {
            Err(diags)
        } else {
            Ok((manifest, diags))
        }
    }

    fn validate(&self) -> Vec<Diagnostic> {
        let mut diags = Vec::new();
        for (port, assignment) in &self.pins {
            validate_port_name(port, &mut diags);
            validate_assignment(port, assignment, &mut diags);
        }
        validate_port_overlap(&self.pins, &mut diags);
        for (name, dep) in &self.dependencies {
            validate_dependency(name, dep, &mut diags);
        }
        diags
    }
}

fn toml_error(e: &toml::de::Error) -> Diagnostic {
    // toml's message may span several lines and repeat the location; keep the first.
    let message = e.message().lines().next().unwrap_or("invalid TOML").trim();
    let d = Diagnostic::error("manifest-syntax", message.to_string());
    match e.span() {
        Some(span) => d.with_primary(span, ""),
        None => d,
    }
}

/// Splits `name[3]` into `("name", Some(3))`.
pub fn split_port_index(port: &str) -> (&str, Option<u32>) {
    if let Some(open) = port.find('[')
        && let Some(inner) = port[open + 1..].strip_suffix(']')
        && let Ok(i) = inner.parse()
    {
        return (&port[..open], Some(i));
    }
    (port, None)
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_port_name(port: &Spanned<String>, diags: &mut Vec<Diagnostic>) {
    let (base, index) = split_port_index(port.get_ref());
    let valid = is_identifier(base) && (index.is_some() || !port.get_ref().contains('['));
    if !valid {
        diags.push(
            Diagnostic::error(
                "invalid-port",
                format!("`{}` is not a valid port name", port.get_ref()),
            )
            .with_primary(port.span(), "expected an identifier, optionally indexed")
            .with_help("use a top-level port name such as `led` or `led[3]`"),
        );
    }
}

fn validate_assignment(
    port: &Spanned<String>,
    a: &Spanned<PinAssignment>,
    diags: &mut Vec<Diagnostic>,
) {
    let inner = a.get_ref();
    let set: Vec<(&str, Span)> = [
        ("signal", inner.signal.as_ref().map(Spanned::span)),
        ("signals", inner.signals.as_ref().map(|_| a.span())),
        ("pin", inner.pin.as_ref().map(Spanned::span)),
        ("pins", inner.pins.as_ref().map(|_| a.span())),
    ]
    .into_iter()
    .filter_map(|(k, s)| s.map(|s| (k, s)))
    .collect();

    match set.as_slice() {
        [] => diags.push(
            Diagnostic::error(
                "missing-location",
                format!("port `{}` has no location", port.get_ref()),
            )
            .with_primary(a.span(), "expected `signal`, `signals`, `pin` or `pins`")
            .with_help("for example: `led = { signal = \"LD0\" }` or `led = { pin = \"U16\" }`"),
        ),
        [_] => {}
        [(first, _), (second, span), ..] => diags.push(
            Diagnostic::error(
                "conflicting-location",
                format!(
                    "port `{}` sets both `{first}` and `{second}`",
                    port.get_ref()
                ),
            )
            .with_primary(span.clone(), format!("`{second}` conflicts with `{first}`"))
            .with_help("give exactly one of `signal`, `signals`, `pin` or `pins`"),
        ),
    }

    let is_bus = inner.signals.is_some() || inner.pins.is_some();
    if is_bus && split_port_index(port.get_ref()).1.is_some() {
        diags.push(
            Diagnostic::error(
                "invalid-port",
                format!(
                    "`{}` is a single bit but is given a list of locations",
                    port.get_ref()
                ),
            )
            .with_primary(port.span(), "")
            .with_help("drop the index to assign the whole bus, or use `pin`/`signal`"),
        );
    }
    for list in [&inner.signals, &inner.pins].into_iter().flatten() {
        if list.is_empty() {
            diags.push(
                Diagnostic::error("missing-location", "location list is empty")
                    .with_primary(a.span(), ""),
            );
        }
    }

    if let Some(n) = &inner.pin_n
        && inner.pin.is_none()
    {
        diags.push(
            Diagnostic::error("invalid-diff-pair", "`pin_n` requires `pin`")
                .with_primary(n.span(), "")
                .with_help("give the positive leg as `pin` and the negative leg as `pin_n`"),
        );
    }
    if let Some(n) = &inner.signal_n
        && inner.signal.is_none()
    {
        diags.push(
            Diagnostic::error("invalid-diff-pair", "`signal_n` requires `signal`")
                .with_primary(n.span(), "")
                .with_help("give the positive leg as `signal` and the negative leg as `signal_n`"),
        );
    }
}

fn validate_port_overlap(
    pins: &BTreeMap<Spanned<String>, Spanned<PinAssignment>>,
    diags: &mut Vec<Diagnostic>,
) {
    // `led = { pins = [...] }` and `"led[0]" = ...` both describe led[0].
    let buses: BTreeMap<&str, &Spanned<String>> = pins
        .iter()
        .filter(|(_, a)| a.get_ref().pins.is_some() || a.get_ref().signals.is_some())
        .map(|(p, _)| (p.get_ref().as_str(), p))
        .collect();
    for port in pins.keys() {
        let (base, index) = split_port_index(port.get_ref());
        if let (Some(i), Some(bus)) = (index, buses.get(base)) {
            diags.push(
                Diagnostic::error(
                    "duplicate-port",
                    format!("`{base}[{i}]` is also assigned by the bus `{base}`"),
                )
                .with_primary(port.span(), "assigned again here")
                .with_secondary(bus.span(), "bus assigned here"),
            );
        }
    }
}

fn validate_dependency(
    name: &Spanned<String>,
    dep: &Spanned<Dependency>,
    diags: &mut Vec<Diagnostic>,
) {
    if let Dependency::Git {
        rev, tag, branch, ..
    } = dep.get_ref()
    {
        let refs = [rev, tag, branch].iter().filter(|r| r.is_some()).count();
        if refs > 1 {
            diags.push(
                Diagnostic::error(
                    "invalid-dependency",
                    format!(
                        "dependency `{}` sets more than one of `rev`, `tag` and `branch`",
                        name.get_ref()
                    ),
                )
                .with_primary(dep.span(), ""),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
[project]
name = "blinky"
top = "blinky"
board = "basys3"
"#;

    fn errors(src: &str) -> Vec<Diagnostic> {
        match Manifest::parse(src) {
            Ok((_, w)) => panic!("expected errors, got Ok with warnings {w:?}"),
            Err(e) => e,
        }
    }

    #[test]
    fn parses_minimal_manifest() {
        let (m, warnings) = Manifest::parse(MINIMAL).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(m.project.board.get_ref(), "basys3");
        assert!(m.pins.is_empty());
    }

    #[test]
    fn parses_full_manifest() {
        let src = format!(
            "{MINIMAL}{}",
            r#"
[sources]
files = ["rtl/*.sv"]
include_dirs = ["rtl/include"]
defines = { WIDTH = "8" }

[constraints]
files = ["timing.xdc"]

[dependencies]
uart = { git = "https://example.com/uart.git", tag = "v1.0.0" }
fifo = { path = "../fifo" }
cdc = { core = "deps/cdc.core" }

[pins]
clk = { signal = "CLK100MHZ", clock = true }
led = { signals = ["LD0", "LD1"] }
"sw[0]" = { pin = "V17", io_standard = "LVCMOS33", pull = "down" }
lvds = { pin = "H16", pin_n = "G16", io_standard = "LVDS_25", diff_term = true }

[sim]
simulator = "verilator"
test_modules = ["test_blinky"]
waves = true

[build]
toolchain = "vivado"
"#
        );
        let (m, _) = Manifest::parse(&src).unwrap();
        assert_eq!(m.pins.len(), 4);
        assert_eq!(m.dependencies.len(), 3);
        let fifo = m.dependencies.iter().find(|(k, _)| k.get_ref() == "fifo");
        assert!(matches!(fifo.unwrap().1.get_ref(), Dependency::Path { .. }));
        assert_eq!(
            *m.sim.unwrap().simulator.unwrap().get_ref(),
            Simulator::Verilator
        );
    }

    #[test]
    fn syntax_error_has_span() {
        let errs = errors("[project\nname = 1");
        assert_eq!(errs[0].code, "manifest-syntax");
        assert!(errs[0].primary.is_some());
    }

    #[test]
    fn unknown_field_is_rejected() {
        let errs = errors(&format!("{MINIMAL}\n[pins]\nled = {{ pinn = \"U16\" }}\n"));
        assert_eq!(errs[0].code, "manifest-syntax");
        assert!(errs[0].message.contains("pinn"), "{}", errs[0].message);
    }

    #[test]
    fn missing_location() {
        let errs = errors(&format!("{MINIMAL}\n[pins]\nled = {{ clock = true }}\n"));
        assert_eq!(errs[0].code, "missing-location");
    }

    #[test]
    fn conflicting_location() {
        let errs = errors(&format!(
            "{MINIMAL}\n[pins]\nled = {{ pin = \"U16\", signal = \"LD0\" }}\n"
        ));
        assert_eq!(errs[0].code, "conflicting-location");
    }

    #[test]
    fn bus_overlap_with_indexed_port() {
        let errs = errors(&format!(
            "{MINIMAL}\n[pins]\nled = {{ pins = [\"U16\"] }}\n\"led[0]\" = {{ pin = \"E19\" }}\n"
        ));
        assert_eq!(errs[0].code, "duplicate-port");
    }

    #[test]
    fn invalid_port_name() {
        let errs = errors(&format!(
            "{MINIMAL}\n[pins]\n\"1led\" = {{ pin = \"U16\" }}\n"
        ));
        assert_eq!(errs[0].code, "invalid-port");
    }

    #[test]
    fn pin_n_requires_pin() {
        let errs = errors(&format!(
            "{MINIMAL}\n[pins]\nx = {{ signal = \"A\", pin_n = \"B\" }}\n"
        ));
        assert_eq!(errs[0].code, "invalid-diff-pair");
    }

    #[test]
    fn split_port_index_works() {
        assert_eq!(split_port_index("led[12]"), ("led", Some(12)));
        assert_eq!(split_port_index("led"), ("led", None));
        assert_eq!(split_port_index("led[x]"), ("led[x]", None));
    }
}
