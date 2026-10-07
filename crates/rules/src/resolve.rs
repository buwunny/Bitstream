//! Resolve `[pins]` entries to package pins on a board.

use bitstream_boards::{SignalPull, Target};
use bitstream_manifest::{Diagnostic, Manifest, PinAssignment, Pull, Slew, Span, Spanned};

use crate::suggest::did_you_mean;

/// A single-bit top-level port resolved to a package pin.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPort {
    /// Port name, with an index for bus bits: `clk`, `led[3]`.
    pub port: String,
    /// Span of the port's key in `[pins]`.
    pub port_span: Span,
    /// Canonical board signal name, if the port was given as a signal.
    pub signal: Option<String>,
    /// Package pin, spelled as in the device pinout.
    pub pin: String,
    /// Span of the `signal`/`pin` string that located this port.
    pub location_span: Span,
    /// Package pin of an explicitly given negative leg.
    pub pin_n: Option<Spanned<String>>,
    /// IO standard: explicit in the manifest, or the board signal's default.
    pub io_standard: Option<IoStandardChoice>,
    pub clock: bool,
    /// Span of `clock = true`, or `None` when implied by a board clock signal.
    pub clock_span: Option<Span>,
    pub pull: Option<Pull>,
    pub slew: Option<Slew>,
    pub drive: Option<u32>,
    pub diff_term: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IoStandardChoice {
    pub name: String,
    /// Span in the manifest, or `None` if it came from the board signal.
    pub span: Option<Span>,
}

impl ResolvedPort {
    /// Span to blame for the IO standard: its own if explicit, else the location.
    pub fn io_standard_span(&self) -> Span {
        self.io_standard
            .as_ref()
            .and_then(|s| s.span.clone())
            .unwrap_or_else(|| self.location_span.clone())
    }
}

/// Resolve every `[pins]` entry. Ports whose location can't be resolved are left out
/// and reported as `unknown-signal` / `unknown-pin` errors.
pub fn resolve(manifest: &Manifest, target: Target<'_>) -> (Vec<ResolvedPort>, Vec<Diagnostic>) {
    let mut ports = Vec::new();
    let mut diags = Vec::new();
    for (port, a) in &manifest.pins {
        let inner = a.get_ref();
        // (port name, location string, is_signal)
        let locations: Vec<(String, &Spanned<String>, bool)> = if let Some(s) = &inner.signal {
            vec![(port.get_ref().clone(), s, true)]
        } else if let Some(p) = &inner.pin {
            vec![(port.get_ref().clone(), p, false)]
        } else if let Some(list) = &inner.signals {
            indexed(port.get_ref(), list, true)
        } else if let Some(list) = &inner.pins {
            indexed(port.get_ref(), list, false)
        } else {
            Vec::new()
        };

        for (name, loc, is_signal) in locations {
            let resolved = if is_signal {
                resolve_signal(target, loc, &mut diags)
            } else {
                resolve_pin(target, loc, &mut diags)
            };
            let Some((pin, signal)) = resolved else {
                continue;
            };
            let pin_n = resolve_n_leg(target, inner, &mut diags);
            ports.push(build(
                name,
                port.span(),
                pin,
                signal,
                loc.span(),
                pin_n,
                inner,
                target,
            ));
        }
    }
    (ports, diags)
}

fn indexed<'a>(
    base: &str,
    list: &'a [Spanned<String>],
    is_signal: bool,
) -> Vec<(String, &'a Spanned<String>, bool)> {
    list.iter()
        .enumerate()
        .map(|(i, loc)| (format!("{base}[{i}]"), loc, is_signal))
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build(
    port: String,
    port_span: Span,
    pin: String,
    signal: Option<String>,
    location_span: Span,
    pin_n: Option<Spanned<String>>,
    a: &PinAssignment,
    target: Target<'_>,
) -> ResolvedPort {
    let board_signal = signal.as_deref().and_then(|s| target.board.signal(s));
    let io_standard = match &a.io_standard {
        Some(s) => Some(IoStandardChoice {
            name: s.get_ref().clone(),
            span: Some(s.span()),
        }),
        None => board_signal
            .and_then(|(_, s)| s.io_standard.clone())
            .map(|name| IoStandardChoice { name, span: None }),
    };
    let board_clock = board_signal.is_some_and(|(_, s)| s.clock);
    let (clock, clock_span) = match &a.clock {
        Some(c) => (*c.get_ref(), Some(c.span())),
        None => (board_clock, None),
    };
    ResolvedPort {
        port,
        port_span,
        signal,
        pin,
        location_span,
        pin_n,
        io_standard,
        clock,
        clock_span,
        // The manifest wins; otherwise use the board's default for the signal.
        pull: a.pull.as_ref().map(|p| *p.get_ref()).or_else(|| {
            board_signal.and_then(|(_, s)| s.pull).map(|p| match p {
                SignalPull::Up => Pull::Up,
                SignalPull::Down => Pull::Down,
                SignalPull::Keeper => Pull::Keeper,
            })
        }),
        slew: a.slew.as_ref().map(|s| *s.get_ref()),
        drive: a.drive.as_ref().map(|d| *d.get_ref()),
        diff_term: a.diff_term.as_ref().map(|d| *d.get_ref()),
    }
}

fn resolve_signal(
    target: Target<'_>,
    loc: &Spanned<String>,
    diags: &mut Vec<Diagnostic>,
) -> Option<(String, Option<String>)> {
    let name = loc.get_ref();
    if let Some((canonical, s)) = target.board.signal(name) {
        let pin = target
            .device
            .pin(&s.pin)
            .map_or_else(|| s.pin.clone(), |p| p.pin.clone());
        return Some((pin, Some(canonical.to_string())));
    }
    let mut d = Diagnostic::error(
        "unknown-signal",
        format!("`{name}` is not a signal on the {}", target.board.name),
    )
    .with_primary(loc.span(), "unknown board signal");
    // An exact package pin beats a fuzzy signal match (`W5` is not a typo of `SW5`).
    if target.device.pin(name).is_some() {
        d = d.with_help(format!(
            "`{name}` is a package pin; use `pin = \"{name}\"` instead of `signal`"
        ));
    } else if let Some(s) = did_you_mean(name, target.board.signal_names()) {
        d = d.with_help(format!("did you mean `{s}`?"));
    } else {
        d = d.with_help(format!(
            "board signals are listed in boards/{}.toml",
            target.board.id
        ));
    }
    diags.push(d);
    None
}

fn resolve_pin(
    target: Target<'_>,
    loc: &Spanned<String>,
    diags: &mut Vec<Diagnostic>,
) -> Option<(String, Option<String>)> {
    let name = loc.get_ref();
    if let Some(p) = target.device.pin(name) {
        return Some((p.pin.clone(), None));
    }
    let package = format!("{}-{}", target.device.device, target.device.package);
    let mut d = Diagnostic::error(
        "unknown-pin",
        format!("package pin `{name}` does not exist on {package}"),
    )
    .with_primary(loc.span(), format!("not a pin of {package}"));
    if target.board.signal(name).is_some() {
        d = d.with_help(format!(
            "`{name}` is a board signal; use `signal = \"{name}\"` instead of `pin`"
        ));
    } else if let Some(s) = did_you_mean(name, target.device.pins.iter().map(|p| p.pin.as_str())) {
        d = d.with_help(format!("did you mean `{s}`?"));
    }
    diags.push(d);
    None
}

/// The explicitly given negative leg, as a package pin.
fn resolve_n_leg(
    target: Target<'_>,
    a: &PinAssignment,
    diags: &mut Vec<Diagnostic>,
) -> Option<Spanned<String>> {
    let (loc, found) = if let Some(n) = &a.pin_n {
        (n, resolve_pin(target, n, diags).map(|(p, _)| p))
    } else if let Some(n) = &a.signal_n {
        (n, resolve_signal(target, n, diags).map(|(p, _)| p))
    } else {
        return None;
    };
    found.map(|pin| Spanned::new(loc.span(), pin))
}
