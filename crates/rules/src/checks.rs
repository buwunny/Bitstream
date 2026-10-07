//! Individual rule checks. Each takes resolved ports and returns diagnostics.

use std::collections::BTreeMap;

use bitstream_boards::{ConstraintFormat, DevicePin, DiffSide, IoStandard, PinKind, Target};
use bitstream_manifest::{Diagnostic, Pull, Span};

use crate::resolve::ResolvedPort;
use crate::suggest::did_you_mean;

/// Run every check.
pub fn all(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut d = Vec::new();
    d.extend(io_standards(ports, t));
    d.extend(diff_pairs(ports, t));
    d.extend(clock_pins(ports, t));
    d.extend(config_pins(ports, t));
    d.extend(duplicate_pins(ports, t));
    d.extend(vref_dci(ports, t));
    d.extend(unsupported_settings(ports, t));
    d
}

fn device_pin<'a>(t: Target<'a>, port: &ResolvedPort) -> &'a DevicePin {
    t.device
        .pin(&port.pin)
        .expect("resolved ports always name a device pin")
}

fn standard<'a>(t: Target<'a>, port: &ResolvedPort) -> Option<&'a IoStandard> {
    port.io_standard
        .as_ref()
        .and_then(|s| t.family.io_standard(&s.name))
}

fn volts(v: f64) -> String {
    format!("{v} V")
}

/// IO standards: unknown names, bank VCCO conflicts, unsupported bank types, and
/// (for Vivado) ports without an IO standard.
///
/// Codes: `unknown-io-standard`, `bank-voltage`, `bank-type`, `unknown-bank-voltage`,
/// `missing-io-standard`.
pub fn io_standards(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for port in ports {
        let pin = device_pin(t, port);
        let Some(choice) = &port.io_standard else {
            if t.family.constraint_format == ConstraintFormat::Xdc && pin.kind == PinKind::Io {
                diags.push(
                    Diagnostic::warning(
                        "missing-io-standard",
                        format!("port `{}` has no IO standard", port.port),
                    )
                    .with_primary(port.location_span.clone(), "")
                    .with_note("Vivado refuses to write a bitstream while any port uses the default IO standard (DRC NSTD-1)")
                    .with_help("add `io_standard = \"...\"` matching the bank voltage, for example LVCMOS33 for 3.3 V"),
                );
            }
            continue;
        };
        let Some(std) = t.family.io_standard(&choice.name) else {
            let span = port.io_standard_span();
            let mut d = Diagnostic::error(
                "unknown-io-standard",
                format!(
                    "`{}` is not an IO standard of the {}",
                    choice.name, t.family.name
                ),
            )
            .with_primary(span, "unknown IO standard");
            if let Some(s) = did_you_mean(
                &choice.name,
                t.family.io_standards.iter().map(|s| s.name.as_str()),
            ) {
                d = d.with_help(format!("did you mean `{s}`?"));
            }
            diags.push(d);
            continue;
        };
        let Some(bank) = &pin.bank else { continue };

        if !std.bank_types.is_empty()
            && let Some(bank_type) = t.device.bank_type(bank)
            && !std.bank_types.iter().any(|b| b == bank_type)
        {
            diags.push(
                Diagnostic::error(
                    "bank-type",
                    format!("{} is not supported in {bank_type} banks", std.name),
                )
                .with_primary(
                    port.io_standard_span(),
                    format!("needs a {} bank", std.bank_types.join("/")),
                )
                .with_secondary(
                    port.location_span.clone(),
                    format!("pin {} is in {bank_type} bank {bank}", pin.pin),
                ),
            );
        }

        let Some(required) = std.vcco else { continue };
        let Some(bank_supply) = t.board.banks.get(bank) else {
            diags.push(
                Diagnostic::warning(
                    "unknown-bank-voltage",
                    format!(
                        "can't check {} on pin {}: the VCCO of bank {bank} is not known for the {}",
                        std.name, pin.pin, t.board.name
                    ),
                )
                .with_primary(port.io_standard_span(), ""),
            );
            continue;
        };
        if (bank_supply.vcco - required).abs() < 1e-6 {
            continue;
        }
        let input_exception = std.differential && port.diff_term == Some(false);
        let message = format!(
            "{} needs VCCO = {}, but bank {bank} is powered at {}",
            std.name,
            volts(required),
            volts(bank_supply.vcco)
        );
        let mut d = if input_exception {
            Diagnostic::warning("bank-voltage", message)
                .with_note("differential inputs without internal termination may be allowed at another VCCO; check the family's IO user guide")
        } else {
            Diagnostic::error("bank-voltage", message)
        }
        .with_primary(port.io_standard_span(), format!("requires {}", volts(required)))
        .with_secondary(
            port.location_span.clone(),
            format!("pin {} is in bank {bank} ({})", pin.pin, volts(bank_supply.vcco)),
        );
        d = d.with_help(bank_voltage_help(t, std, bank, bank_supply.vcco));
        diags.push(d);
    }
    diags
}

fn bank_voltage_help(t: Target<'_>, std: &IoStandard, bank: &str, vcco: f64) -> String {
    let bank_type = t.device.bank_type(bank);
    let alternatives: Vec<&str> = t
        .family
        .io_standards
        .iter()
        .filter(|s| {
            s.vcco.is_some_and(|v| (v - vcco).abs() < 1e-6)
                && s.differential == std.differential
                && !s.vref
                && !s.dci
                && (s.bank_types.is_empty()
                    || bank_type.is_some_and(|b| s.bank_types.iter().any(|x| x == b)))
        })
        .map(|s| s.name.as_str())
        .collect();
    let required = std.vcco.unwrap_or_default();
    // Only banks with user IO are somewhere to move a port to (not 7-series bank 0).
    let has_user_io = |bank: &str| {
        t.device
            .pins
            .iter()
            .any(|p| p.kind == PinKind::Io && p.bank.as_deref() == Some(bank))
    };
    let matching_banks: Vec<&str> = t
        .board
        .banks
        .iter()
        .filter(|(k, b)| (b.vcco - required).abs() < 1e-6 && has_user_io(k))
        .map(|(k, _)| k.as_str())
        .collect();

    let kind = if std.differential {
        "differential "
    } else {
        ""
    };
    let mut help = if alternatives.is_empty() {
        format!("no {kind}IO standard works at {} in this bank", volts(vcco))
    } else {
        format!(
            "{kind}IO standards for a {} bank: {}",
            volts(vcco),
            alternatives.join(", ")
        )
    };
    if matching_banks.is_empty() {
        help.push_str(&format!(
            "; the {} has no bank powered at {}",
            t.board.name,
            volts(required)
        ));
    } else {
        help.push_str(&format!(
            "; or move the port to bank {} ({})",
            matching_banks.join("/"),
            volts(required)
        ));
    }
    help
}

/// Differential standards on pins that aren't the P leg of a pair, wrong N legs,
/// and N legs given for single-ended standards. Code: `diff-pair`.
pub fn diff_pairs(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for port in ports {
        let pin = device_pin(t, port);
        let std = standard(t, port);
        let differential = std.is_some_and(|s| s.differential);

        if !differential {
            if let Some(n) = &port.pin_n {
                let mut d = Diagnostic::error(
                    "diff-pair",
                    format!(
                        "port `{}` has a negative leg but a single-ended IO standard",
                        port.port
                    ),
                )
                .with_primary(n.span(), "negative leg given here");
                d = match (std, &port.io_standard) {
                    (Some(s), Some(c)) => d
                        .with_secondary(
                            port.io_standard_span(),
                            format!("{} is single-ended", s.name),
                        )
                        .with_help(if c.span.is_some() {
                            "use a differential IO standard, or drop `pin_n`/`signal_n`"
                        } else {
                            "set a differential `io_standard`, or drop `pin_n`/`signal_n`"
                        }),
                    _ => d.with_help("set a differential `io_standard`, such as LVDS_25"),
                };
                diags.push(d);
            }
            continue;
        }
        let std = std.expect("differential implies a known standard");

        match pin.diff {
            Some(DiffSide::P) => {}
            Some(DiffSide::N) => {
                let partner = pin.pair.as_deref().unwrap_or("?");
                diags.push(
                    Diagnostic::error(
                        "diff-pair",
                        format!("{} is differential, but pin {} is the negative leg of its pair", std.name, pin.pin),
                    )
                    .with_primary(port.location_span.clone(), format!("{} is the N leg", pin.name))
                    .with_help(format!("locate the port on the positive leg `{partner}`; the tools place the N leg automatically")),
                );
                continue;
            }
            None => {
                diags.push(
                    Diagnostic::error(
                        "diff-pair",
                        format!(
                            "{} is differential, but pin {} is not part of a differential pair",
                            std.name, pin.pin
                        ),
                    )
                    .with_primary(
                        port.location_span.clone(),
                        format!("{} has no partner pin", pin.name),
                    )
                    .with_help(
                        "use the P leg of a differential pair, or a single-ended IO standard",
                    ),
                );
                continue;
            }
        }

        if let Some(n) = &port.pin_n
            && pin
                .pair
                .as_deref()
                .is_none_or(|p| !p.eq_ignore_ascii_case(n.get_ref()))
        {
            let partner = pin.pair.as_deref().unwrap_or("?");
            diags.push(
                Diagnostic::error(
                    "diff-pair",
                    format!(
                        "pins {} and {} are not a differential pair",
                        pin.pin,
                        n.get_ref()
                    ),
                )
                .with_primary(n.span(), format!("not the partner of {}", pin.pin))
                .with_secondary(
                    port.location_span.clone(),
                    format!("{} pairs with {partner}", pin.name),
                )
                .with_help(format!("the negative leg of {} is {partner}", pin.pin)),
            );
        }
    }
    diags
}

/// Clock ports on pins that can't drive the clock network. Code: `clock-pin`.
pub fn clock_pins(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for port in ports.iter().filter(|p| p.clock) {
        let pin = device_pin(t, port);
        if pin.clock.is_some() {
            continue;
        }
        let mut d = Diagnostic::error(
            "clock-pin",
            format!(
                "clock port `{}` is on pin {}, which is not clock-capable",
                port.port, pin.pin
            ),
        )
        .with_primary(
            port.location_span.clone(),
            format!("{} is a general-purpose IO", pin.name),
        );
        if let Some(span) = &port.clock_span {
            d = d.with_secondary(span.clone(), "marked as a clock here");
        }
        let candidates: Vec<String> = t
            .device
            .pins
            .iter()
            .filter(|p| p.clock.is_some() && p.diff != Some(DiffSide::N) && p.bank == pin.bank)
            .take(4)
            .map(|p| p.pin.clone())
            .collect();
        d = if candidates.is_empty() {
            d.with_help("move the clock to a clock-capable pin")
        } else {
            d.with_help(format!(
                "move the clock to a clock-capable pin, for example {} in the same bank",
                candidates.join(", ")
            ))
        };
        diags.push(d);
    }
    diags
}

/// Ports on pins that aren't user IO (errors) or that share a configuration
/// function (warnings). Codes: `not-user-io`, `dual-purpose-pin`.
pub fn config_pins(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let mut check = |pin: &DevicePin, span: Span, from_board: bool| {
        if pin.kind != PinKind::Io {
            let kind = match pin.kind {
                PinKind::Config => "a dedicated configuration pin",
                PinKind::Power => "a power pin",
                PinKind::Ground => "a ground pin",
                PinKind::Analog => "a dedicated analog pin",
                PinKind::Nc => "not connected",
                PinKind::Other | PinKind::Io => "not a user IO",
            };
            diags.push(
                Diagnostic::error(
                    "not-user-io",
                    format!("pin {} ({}) is {kind}", pin.pin, pin.name),
                )
                .with_primary(span, "not a user IO pin")
                .with_help("choose a pin whose name starts with IO"),
            );
        } else if !pin.config.is_empty() && !from_board {
            diags.push(
                Diagnostic::warning(
                    "dual-purpose-pin",
                    format!("pin {} ({}) is shared with configuration function {}", pin.pin, pin.name, pin.config.join("/")),
                )
                .with_primary(span, "dual-purpose pin")
                .with_note("the pin becomes user IO after configuration, but anything driving it must not disturb configuration")
                .with_help("prefer a plain user IO, or confirm the board circuit allows this"),
            );
        }
    };
    for port in ports {
        check(
            device_pin(t, port),
            port.location_span.clone(),
            port.signal.is_some(),
        );
        // A port given as `signal` can only take its N leg from `signal_n`, which is
        // a board signal too.
        if let Some(n) = &port.pin_n
            && let Some(p) = t.device.pin(n.get_ref())
        {
            check(p, n.span(), port.signal.is_some());
        }
    }
    diags
}

/// Two ports (or legs of differential ports) on the same package pin.
/// Code: `duplicate-pin`.
pub fn duplicate_pins(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let mut used: BTreeMap<String, (&str, Span)> = BTreeMap::new();
    for port in ports {
        let mut legs = vec![(port.pin.clone(), port.location_span.clone())];
        if let Some(n) = &port.pin_n {
            legs.push((n.get_ref().clone(), n.span()));
        } else if standard(t, port).is_some_and(|s| s.differential)
            && let Some(pair) = &device_pin(t, port).pair
        {
            // The tools place the N leg implicitly.
            legs.push((pair.clone(), port.location_span.clone()));
        }
        for (pin, span) in legs {
            let key = pin.to_ascii_uppercase();
            match used.get(&key) {
                Some((other, other_span)) if *other != port.port.as_str() => {
                    diags.push(
                        Diagnostic::error(
                            "duplicate-pin",
                            format!(
                                "pin {pin} is assigned to both `{other}` and `{}`",
                                port.port
                            ),
                        )
                        .with_primary(span, format!("`{}` uses {pin}", port.port))
                        .with_secondary(other_span.clone(), format!("`{other}` uses {pin}"))
                        .with_help("each package pin can drive only one port"),
                    );
                }
                Some(_) => {}
                None => {
                    used.insert(key, (port.port.as_str(), span));
                }
            }
        }
    }
    diags
}

/// VREF and DCI requirements. Code: `vref-dci`.
///
/// Only the DCI half is implemented: standards that need DCI must sit in a bank
/// with VRN/VRP pins.
// TODO: VREF: when a bank uses a VREF standard, check that the board supplies VREF
// (or INTERNAL_VREF is set), that all VREF standards in the bank agree on the
// voltage, and that the bank's VREF pins aren't used as IO.
// TODO: DCI: check that the board fits the VRN/VRP reference resistors, and
// support DCI_CASCADE across banks.
pub fn vref_dci(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    for port in ports {
        let Some(std) = standard(t, port) else {
            continue;
        };
        if !std.dci {
            continue;
        }
        let pin = device_pin(t, port);
        let Some(bank) = &pin.bank else { continue };
        let has_reference = t
            .device
            .pins
            .iter()
            .any(|p| p.bank.as_ref() == Some(bank) && p.dci.is_some());
        if !has_reference {
            diags.push(
                Diagnostic::error(
                    "vref-dci",
                    format!(
                        "{} uses DCI, but bank {bank} has no VRN/VRP reference pins",
                        std.name
                    ),
                )
                .with_primary(port.io_standard_span(), "needs DCI")
                .with_help("use the non-DCI variant of the standard, or a bank with VRN/VRP pins"),
            );
        }
    }
    diags
}

/// Per-port settings the target's constraint format can't express.
/// Code: `unsupported-setting`.
pub fn unsupported_settings(ports: &[ResolvedPort], t: Target<'_>) -> Vec<Diagnostic> {
    if t.family.constraint_format != ConstraintFormat::Pcf {
        return Vec::new();
    }
    let mut diags = Vec::new();
    for port in ports {
        let mut unsupported = Vec::new();
        if matches!(port.pull, Some(Pull::Down | Pull::Keeper)) {
            unsupported.push("a pull-down or keeper");
        }
        if port.slew.is_some() {
            unsupported.push("`slew`");
        }
        if port.drive.is_some() {
            unsupported.push("`drive`");
        }
        if port.diff_term.is_some() {
            unsupported.push("`diff_term`");
        }
        if unsupported.is_empty() {
            continue;
        }
        diags.push(
            Diagnostic::warning(
                "unsupported-setting",
                format!(
                    "port `{}` sets {}, which the {} toolchain ignores",
                    port.port,
                    unsupported.join(", "),
                    t.family.name
                ),
            )
            .with_primary(port.port_span.clone(), format!("on port `{}`", port.port))
            .with_note("nextpnr PCF files can only set the pin and an optional pull-up"),
        );
    }
    diags
}
