//! FPGA family, device and board data.
//!
//! All data lives in TOML under the repository's `boards/` directory:
//!
//! - `boards/families/*.toml`: IO standards and other per-family facts ([`Family`]).
//! - `boards/devices/*.toml`: package pinouts, one file per device and package ([`Device`]).
//! - `boards/*.toml`: boards, mapping named signals to package pins ([`Board`]).
//!
//! The files are embedded at build time, see [`Database::builtin`]. Every value must
//! come from a primary source recorded in the file; see `boards/README.md`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

/// Files embedded from `boards/`, as `(relative path, contents)`.
const EMBEDDED: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

/// Where a piece of data came from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub url: String,
    /// What this source was used for, for example `"signal pins"` or `"bank VCCO"`.
    #[serde(default)]
    pub covers: Option<String>,
}

/// Facts shared by every device in an FPGA family.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Family {
    pub id: String,
    pub name: String,
    /// Constraint file format the family's toolchain consumes.
    pub constraint_format: ConstraintFormat,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub io_standards: Vec<IoStandard>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConstraintFormat {
    Xdc,
    Pcf,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IoStandard {
    pub name: String,
    /// Bank VCCO the standard requires, in volts. Omitted when the standard places no
    /// requirement on VCCO.
    #[serde(default)]
    pub vcco: Option<f64>,
    /// Bank types (for example `HR`, `HP`) that support the standard. Empty means all.
    #[serde(default)]
    pub bank_types: Vec<String>,
    #[serde(default)]
    pub differential: bool,
    /// Needs a VREF reference voltage in the bank.
    #[serde(default)]
    pub vref: bool,
    /// Uses digitally controlled impedance and needs VRN/VRP resistors in the bank.
    #[serde(default)]
    pub dci: bool,
}

/// One package pinout of one device.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    /// Identifier boards refer to, for example `xc7a35t-cpg236`.
    pub id: String,
    pub family: String,
    pub device: String,
    pub package: String,
    pub sources: Vec<Source>,
    /// Bank number to IO type (for example `"14" = "HR"`). Optional per family.
    #[serde(default)]
    pub bank_types: BTreeMap<String, String>,
    pub pins: Vec<DevicePin>,
    #[serde(skip)]
    index: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevicePin {
    /// Package pin, for example `W5` or `35`.
    pub pin: String,
    /// Pin name exactly as written in the vendor pinout, for example
    /// `IO_L12P_T1_MRCC_34`.
    pub name: String,
    pub kind: PinKind,
    #[serde(default)]
    pub bank: Option<String>,
    /// Differential side of this pin, if it is part of a pair.
    #[serde(default)]
    pub diff: Option<DiffSide>,
    /// Package pin of the other leg of the pair.
    #[serde(default)]
    pub pair: Option<String>,
    /// Clock-capable input type, for example `MRCC`, `SRCC` or `GBIN`.
    #[serde(default)]
    pub clock: Option<String>,
    /// Configuration functions shared with this user IO, for example `["CCLK"]` or
    /// `["D00", "MOSI"]`. Empty for plain user IO.
    #[serde(default)]
    pub config: Vec<String>,
    /// Pin can act as the bank's VREF input.
    #[serde(default)]
    pub vref: bool,
    /// Pin is the bank's DCI reference (`VRN` or `VRP`).
    #[serde(default)]
    pub dci: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PinKind {
    /// User IO, possibly with dual-purpose functions.
    Io,
    /// Dedicated configuration or JTAG pin.
    Config,
    Power,
    Ground,
    Analog,
    /// No connect.
    Nc,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum DiffSide {
    P,
    N,
}

/// A development board.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Board {
    /// Identifier used in `project.board`, for example `basys3`.
    pub id: String,
    pub name: String,
    pub vendor: String,
    /// Id of the [`Device`] (device plus package) on the board.
    pub device: String,
    /// Full default part number, for example `xc7a35tcpg236-1`.
    pub part: String,
    pub sources: Vec<Source>,
    /// Device-wide settings emitted into generated constraints.
    #[serde(default)]
    pub config: BoardConfig,
    /// Bank number to its supply.
    #[serde(default)]
    pub banks: BTreeMap<String, Bank>,
    /// Board signal name to its location.
    #[serde(default)]
    pub signals: BTreeMap<String, BoardSignal>,
    /// Data that could not be verified from a primary source.
    #[serde(default)]
    pub todo: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardConfig {
    /// Value for the 7-series `CONFIG_VOLTAGE` property.
    #[serde(default)]
    pub config_voltage: Option<f64>,
    /// Value for the 7-series `CFGBVS` property (`VCCO` or `GND`).
    #[serde(default)]
    pub cfgbvs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bank {
    /// Bank supply voltage in volts.
    pub vcco: f64,
    /// URL of the source for this value, if different from the board's sources.
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardSignal {
    pub pin: String,
    /// IO standard used by the vendor's reference constraints.
    #[serde(default)]
    pub io_standard: Option<String>,
    /// Other names for the signal, such as the silkscreen label.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// The signal is a clock source on the board.
    #[serde(default)]
    pub clock: bool,
    #[serde(default)]
    pub description: Option<String>,
}

/// A board together with its device and family.
#[derive(Debug, Clone, Copy)]
pub struct Target<'a> {
    pub board: &'a Board,
    pub device: &'a Device,
    pub family: &'a Family,
}

impl Family {
    /// Looks up an IO standard, ignoring ASCII case.
    pub fn io_standard(&self, name: &str) -> Option<&IoStandard> {
        self.io_standards
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(name))
    }
}

impl Device {
    /// Looks up a package pin, ignoring ASCII case.
    pub fn pin(&self, pin: &str) -> Option<&DevicePin> {
        self.index
            .get(&pin.to_ascii_uppercase())
            .map(|&i| &self.pins[i])
    }

    /// IO type of a bank, such as `HR` or `HP`, if the family distinguishes them.
    pub fn bank_type(&self, bank: &str) -> Option<&str> {
        self.bank_types.get(bank).map(String::as_str)
    }

    fn build_index(&mut self) {
        self.index = self
            .pins
            .iter()
            .enumerate()
            .map(|(i, p)| (p.pin.to_ascii_uppercase(), i))
            .collect();
    }
}

impl Board {
    /// Looks up a signal by its name or one of its aliases. Returns the canonical name.
    pub fn signal(&self, name: &str) -> Option<(&str, &BoardSignal)> {
        if let Some((k, v)) = self.signals.get_key_value(name) {
            return Some((k.as_str(), v));
        }
        self.signals
            .iter()
            .find(|(_, s)| s.aliases.iter().any(|a| a == name))
            .map(|(k, v)| (k.as_str(), v))
    }

    /// Every name a signal can be referred to by, canonical names first.
    pub fn signal_names(&self) -> impl Iterator<Item = &str> {
        self.signals.keys().map(String::as_str).chain(
            self.signals
                .values()
                .flat_map(|s| s.aliases.iter().map(String::as_str)),
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("{path}: {message}")]
    Parse { path: String, message: String },
    #[error("{path}: {message}")]
    Invalid { path: String, message: String },
}

/// All known families, devices and boards.
#[derive(Debug, Default)]
pub struct Database {
    families: BTreeMap<String, Family>,
    devices: BTreeMap<String, Device>,
    boards: BTreeMap<String, Board>,
}

impl Database {
    /// The data embedded from the repository's `boards/` directory.
    ///
    /// # Panics
    /// Panics if the embedded data is invalid; the `builtin_data_is_valid` test
    /// guarantees it is not.
    pub fn builtin() -> &'static Database {
        static DB: OnceLock<Database> = OnceLock::new();
        DB.get_or_init(|| {
            Database::from_files(EMBEDDED.iter().copied())
                .unwrap_or_else(|e| panic!("embedded board data is invalid: {e}"))
        })
    }

    /// Load from `(path, contents)` pairs, with paths relative to the data root.
    /// Files in `families/` and `devices/` are families and devices; all other
    /// files are boards.
    pub fn from_files<'a>(
        files: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Database, LoadError> {
        let mut db = Database::default();
        for (path, text) in files {
            let parse_err = |e: toml::de::Error| LoadError::Parse {
                path: path.to_string(),
                message: e.to_string(),
            };
            let dup = |id: &str| LoadError::Invalid {
                path: path.to_string(),
                message: format!("duplicate id `{id}`"),
            };
            if path.starts_with("families/") {
                let f: Family = toml::from_str(text).map_err(parse_err)?;
                if db.families.contains_key(&f.id) {
                    return Err(dup(&f.id));
                }
                db.families.insert(f.id.clone(), f);
            } else if path.starts_with("devices/") {
                let mut d: Device = toml::from_str(text).map_err(parse_err)?;
                d.build_index();
                if db.devices.contains_key(&d.id) {
                    return Err(dup(&d.id));
                }
                db.devices.insert(d.id.clone(), d);
            } else {
                let b: Board = toml::from_str(text).map_err(parse_err)?;
                if db.boards.contains_key(&b.id) {
                    return Err(dup(&b.id));
                }
                db.boards.insert(b.id.clone(), b);
            }
        }
        db.check()?;
        Ok(db)
    }

    pub fn family(&self, id: &str) -> Option<&Family> {
        self.families.get(id)
    }

    pub fn device(&self, id: &str) -> Option<&Device> {
        self.devices.get(id)
    }

    pub fn board(&self, id: &str) -> Option<&Board> {
        self.boards.get(id)
    }

    pub fn boards(&self) -> impl Iterator<Item = &Board> {
        self.boards.values()
    }

    /// A board with its device and family. Cross references are checked at load
    /// time, so this only fails for unknown board ids.
    pub fn target(&self, board_id: &str) -> Option<Target<'_>> {
        let board = self.boards.get(board_id)?;
        let device = &self.devices[&board.device];
        let family = &self.families[&device.family];
        Some(Target {
            board,
            device,
            family,
        })
    }

    /// Checks cross references and internal consistency.
    fn check(&self) -> Result<(), LoadError> {
        for d in self.devices.values() {
            let path = format!("devices/{}", d.id);
            let invalid = |message: String| LoadError::Invalid {
                path: path.clone(),
                message,
            };
            if !self.families.contains_key(&d.family) {
                return Err(invalid(format!("unknown family `{}`", d.family)));
            }
            if d.index.len() != d.pins.len() {
                return Err(invalid("duplicate package pin".into()));
            }
            for p in &d.pins {
                if let Some(pair) = &p.pair {
                    let other = d
                        .pin(pair)
                        .ok_or_else(|| invalid(format!("{}: pair `{pair}` not found", p.pin)))?;
                    let symmetric = other.pair.as_deref() == Some(p.pin.as_str());
                    let sides = matches!(
                        (p.diff, other.diff),
                        (Some(DiffSide::P), Some(DiffSide::N))
                            | (Some(DiffSide::N), Some(DiffSide::P))
                    );
                    if !symmetric || !sides {
                        return Err(invalid(format!(
                            "{} and {pair} are not a symmetric P/N pair",
                            p.pin
                        )));
                    }
                }
                if let Some(bank) = &p.bank
                    && !d.bank_types.is_empty()
                    && p.kind == PinKind::Io
                    && !d.bank_types.contains_key(bank)
                {
                    return Err(invalid(format!("{}: bank {bank} has no bank type", p.pin)));
                }
            }
        }
        for b in self.boards.values() {
            let path = format!("{}.toml", b.id);
            let invalid = |message: String| LoadError::Invalid {
                path: path.clone(),
                message,
            };
            let d = self
                .devices
                .get(&b.device)
                .ok_or_else(|| invalid(format!("unknown device `{}`", b.device)))?;
            let family = &self.families[&d.family];
            for bank in b.banks.keys() {
                if !d.pins.iter().any(|p| p.bank.as_deref() == Some(bank)) {
                    return Err(invalid(format!("bank {bank} does not exist on {}", d.id)));
                }
            }
            let mut names = std::collections::BTreeSet::new();
            for (name, s) in &b.signals {
                let pin = d.pin(&s.pin).ok_or_else(|| {
                    invalid(format!("signal `{name}`: pin {} not on {}", s.pin, d.id))
                })?;
                if pin.kind != PinKind::Io {
                    return Err(invalid(format!(
                        "signal `{name}`: pin {} is not a user IO",
                        s.pin
                    )));
                }
                if let Some(std) = &s.io_standard
                    && family.io_standard(std).is_none()
                {
                    return Err(invalid(format!(
                        "signal `{name}`: unknown IO standard `{std}`"
                    )));
                }
                for n in std::iter::once(name).chain(&s.aliases) {
                    if !names.insert(n.as_str()) {
                        return Err(invalid(format!("signal name `{n}` is used twice")));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMILY: &str = r#"
id = "fam"
name = "Test family"
constraint_format = "xdc"
io_standards = [{ name = "LVCMOS33", vcco = 3.3 }]
"#;
    const DEVICE: &str = r#"
id = "dev-pkg"
family = "fam"
device = "dev"
package = "pkg"
sources = [{ url = "https://example.com/pinout.txt" }]
bank_types = { "1" = "HR" }
pins = [
  { pin = "A1", name = "IO_L1P_1", kind = "io", bank = "1", diff = "P", pair = "A2" },
  { pin = "A2", name = "IO_L1N_1", kind = "io", bank = "1", diff = "N", pair = "A1" },
  { pin = "A3", name = "GND", kind = "ground" },
]
"#;
    const BOARD: &str = r#"
id = "brd"
name = "Test board"
vendor = "Nobody"
device = "dev-pkg"
part = "devpkg-1"
sources = [{ url = "https://example.com/board.xdc" }]
banks = { "1" = { vcco = 3.3 } }
signals = { "led[0]" = { pin = "a1", io_standard = "LVCMOS33", aliases = ["LD0"] } }
"#;

    fn load(board: &str) -> Result<Database, LoadError> {
        Database::from_files([
            ("families/fam.toml", FAMILY),
            ("devices/dev-pkg.toml", DEVICE),
            ("brd.toml", board),
        ])
    }

    #[test]
    fn loads_and_resolves() {
        let db = load(BOARD).unwrap();
        let t = db.target("brd").unwrap();
        assert_eq!(t.device.pin("a2").unwrap().name, "IO_L1N_1");
        assert_eq!(t.board.signal("LD0").unwrap().0, "led[0]");
        assert!(t.family.io_standard("lvcmos33").is_some());
    }

    #[test]
    fn rejects_signal_on_missing_pin() {
        let bad = BOARD.replace("pin = \"a1\"", "pin = \"Z9\"");
        assert!(load(&bad).unwrap_err().to_string().contains("Z9"));
    }

    #[test]
    fn rejects_signal_on_power_pin() {
        let bad = BOARD.replace("pin = \"a1\"", "pin = \"A3\"");
        assert!(
            load(&bad)
                .unwrap_err()
                .to_string()
                .contains("not a user IO")
        );
    }

    #[test]
    fn rejects_unknown_bank() {
        let bad = BOARD.replace("\"1\" = { vcco", "\"7\" = { vcco");
        assert!(load(&bad).unwrap_err().to_string().contains("bank 7"));
    }

    #[test]
    fn builtin_data_is_valid() {
        let db = Database::from_files(EMBEDDED.iter().copied()).unwrap();
        for board in db.boards() {
            assert!(!board.sources.is_empty(), "{} has no sources", board.id);
            assert!(db.target(&board.id).is_some());
        }
    }

    // Values below are read from the AMD package pinout files
    // a7packages/xc7a35tcpg236pkg.txt and a7packages/xc7a35tcsg324pkg.txt.
    #[test]
    fn xc7a35t_cpg236_pins() {
        let db = Database::from_files(EMBEDDED.iter().copied()).unwrap();
        let d = db.device("xc7a35t-cpg236").unwrap();
        assert_eq!(d.family, "xilinx-7series");
        assert_eq!(d.pins.len(), 238);
        assert_eq!(d.bank_type("34"), Some("HR"));

        let w5 = d.pin("W5").unwrap();
        assert_eq!(w5.name, "IO_L12P_T1_MRCC_34");
        assert_eq!(w5.kind, PinKind::Io);
        assert_eq!(w5.bank.as_deref(), Some("34"));
        assert_eq!(w5.clock.as_deref(), Some("MRCC"));
        assert_eq!(w5.diff, Some(DiffSide::P));
        assert_eq!(w5.pair.as_deref(), Some("W4"));
        let w4 = d.pin("W4").unwrap();
        assert_eq!(w4.name, "IO_L12N_T1_MRCC_34");
        assert_eq!(w4.diff, Some(DiffSide::N));
        assert_eq!(w4.pair.as_deref(), Some("W5"));

        let done = d.pin("U12").unwrap();
        assert_eq!(done.name, "DONE_0");
        assert_eq!(done.kind, PinKind::Config);
        assert_eq!(done.bank.as_deref(), Some("0"));

        let d18 = d.pin("D18").unwrap();
        assert_eq!(d18.name, "IO_L1P_T0_D00_MOSI_14");
        assert_eq!(d18.config, ["D00", "MOSI"]);

        let v17 = d.pin("V17").unwrap();
        assert_eq!(v17.name, "IO_L19N_T3_A09_D25_VREF_14");
        assert!(v17.vref);
        assert_eq!(v17.config, ["A09", "D25"]);

        // IO_L6P_35 is not bonded out in this package, so L1 has no pair.
        let l1 = d.pin("L1").unwrap();
        assert_eq!(l1.name, "IO_L6N_T0_VREF_35");
        assert_eq!((l1.diff, l1.pair.as_deref()), (None, None));

        assert_eq!(d.pin("A12").unwrap().kind, PinKind::Analog); // VP_0
        let b4 = d.pin("B4").unwrap();
        assert_eq!(b4.name, "MGTPRXP0_216");
        assert_eq!(b4.kind, PinKind::Other);
    }

    #[test]
    fn xc7a35t_csg324_pins() {
        let db = Database::from_files(EMBEDDED.iter().copied()).unwrap();
        let d = db.device("xc7a35t-csg324").unwrap();
        assert_eq!(d.pins.len(), 324);
        assert_eq!(d.bank_type("15"), Some("HR"));

        let e3 = d.pin("E3").unwrap();
        assert_eq!(e3.name, "IO_L12P_T1_MRCC_35");
        assert_eq!(e3.clock.as_deref(), Some("MRCC"));
        assert_eq!(e3.pair.as_deref(), Some("D3"));

        assert_eq!(d.pin("P9").unwrap().name, "PROGRAM_B_0");
        assert_eq!(d.pin("P9").unwrap().kind, PinKind::Config);
        assert_eq!(d.pin("N9").unwrap().kind, PinKind::Power); // VCCINT
        assert_eq!(d.pin("G14").unwrap().config, ["ADV_B"]);
        assert_eq!(d.pin("J15").unwrap().config, ["RS0"]);
        assert_eq!(d.pin("L16").unwrap().config, ["EMCCLK"]);
    }

    // Values below are from AMD UG471 v1.10, Tables 1-55 and 1-56.
    #[test]
    fn xilinx_7series_io_standards() {
        let db = Database::from_files(EMBEDDED.iter().copied()).unwrap();
        let f = db.family("xilinx-7series").unwrap();
        assert_eq!(f.constraint_format, ConstraintFormat::Xdc);

        let lvds25 = f.io_standard("LVDS_25").unwrap();
        assert_eq!(lvds25.vcco, Some(2.5));
        assert_eq!(lvds25.bank_types, ["HR"]);
        assert!(lvds25.differential && !lvds25.vref && !lvds25.dci);

        assert_eq!(f.io_standard("LVDS").unwrap().bank_types, ["HP"]);
        let lvcmos33 = f.io_standard("LVCMOS33").unwrap();
        assert_eq!(
            (lvcmos33.vcco, lvcmos33.bank_types.as_slice()),
            (Some(3.3), &["HR".to_string()][..])
        );
        let sstl15 = f.io_standard("SSTL15").unwrap();
        assert_eq!(sstl15.bank_types, ["HR", "HP"]);
        assert!(sstl15.vref && !sstl15.dci && !sstl15.differential);
        let hstl_dci = f.io_standard("HSTL_I_DCI").unwrap();
        assert_eq!(hstl_dci.vcco, Some(1.5));
        assert!(hstl_dci.dci && hstl_dci.vref);
        assert_eq!(hstl_dci.bank_types, ["HP"]);
    }

    #[test]
    fn builtin_icebreaker_clock() {
        let db = Database::from_files(EMBEDDED.iter().copied()).unwrap();
        let t = db.target("icebreaker").unwrap();
        assert_eq!(t.family.constraint_format, ConstraintFormat::Pcf);
        // 12 MHz oscillator on pin 35, IOT_46b_G0 (iCEBreaker PCF, Lattice pinout).
        let (name, clk) = t.board.signal("clk12").unwrap();
        assert_eq!(name, "CLK");
        assert!(clk.clock);
        assert_eq!(clk.pin, "35");
        let pin = t.device.pin(&clk.pin).unwrap();
        assert_eq!(pin.name, "IOT_46b_G0");
        assert_eq!(pin.clock.as_deref(), Some("GBIN"));
        assert_eq!(t.board.signal("LEDR_N").unwrap().1.pin, "11");
    }

    #[test]
    fn builtin_ice40up5k_sg48_pins() {
        let db = Database::from_files(EMBEDDED.iter().copied()).unwrap();
        let d = db.device("ice40up5k-sg48").unwrap();
        assert_eq!(d.pins.len(), 49); // 48 pins plus the GND paddle

        // GBIN G6 on pin 44, one leg of the pair with IOB_2a on pin 47.
        let g6 = d.pin("44").unwrap();
        assert_eq!(g6.name, "IOB_3b_G6");
        assert_eq!(g6.clock.as_deref(), Some("GBIN"));
        assert_eq!(g6.diff, Some(DiffSide::N));
        assert_eq!(g6.pair.as_deref(), Some("47"));

        let cdone = d.pin("7").unwrap();
        assert_eq!(cdone.name, "CDONE");
        assert_eq!(cdone.kind, PinKind::Config);
        assert_eq!(d.pin("8").unwrap().kind, PinKind::Config);

        // SPI configuration pin shared with user IO.
        let so = d.pin("14").unwrap();
        assert_eq!(so.name, "IOB_32a_SPI_SO");
        assert_eq!(so.kind, PinKind::Io);
        assert_eq!(so.config, ["SPI_SO"]);

        assert_eq!(d.pin("39").unwrap().name, "RGB0");
        assert_eq!(d.pin("paddle").unwrap().kind, PinKind::Ground);
    }
}
