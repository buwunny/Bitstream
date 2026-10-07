//! Board-level rule checks for `bitstream.toml`.
//!
//! [`check`] looks up the manifest's board, resolves every `[pins]` entry to a
//! package pin ([`resolve`]) and runs the checks in [`checks`]. Every diagnostic's
//! spans point into the manifest source.

pub mod checks;
mod resolve;
mod suggest;

use bitstream_boards::{Database, Target};
use bitstream_manifest::{Diagnostic, Manifest};

pub use resolve::{IoStandardChoice, ResolvedPort, resolve};
pub use suggest::did_you_mean;

/// The outcome of checking a manifest against its board.
#[derive(Debug)]
pub struct Report<'db> {
    /// `None` when the board is unknown; no pin checks ran.
    pub target: Option<Target<'db>>,
    /// Ports that resolved to a package pin, in manifest order with buses expanded.
    pub ports: Vec<ResolvedPort>,
    /// Sorted by position in the manifest.
    pub diagnostics: Vec<Diagnostic>,
}

impl Report<'_> {
    pub fn has_errors(&self) -> bool {
        self.diagnostics.iter().any(Diagnostic::is_error)
    }
}

/// Check a parsed manifest against the board database.
pub fn check<'db>(manifest: &Manifest, db: &'db Database) -> Report<'db> {
    let board = &manifest.project.board;
    let Some(target) = db.target(board.get_ref()) else {
        let mut d = Diagnostic::error(
            "unknown-board",
            format!("unknown board `{}`", board.get_ref()),
        )
        .with_primary(board.span(), "not in the board database");
        let ids: Vec<&str> = db.boards().map(|b| b.id.as_str()).collect();
        d = match did_you_mean(board.get_ref(), ids.iter().copied()) {
            Some(s) => d.with_help(format!("did you mean `{s}`?")),
            None => d.with_help(format!("known boards: {}", ids.join(", "))),
        };
        return Report {
            target: None,
            ports: Vec::new(),
            diagnostics: vec![d],
        };
    };

    let mut diagnostics = Vec::new();
    if let Some(part) = &manifest.project.part {
        let p = part.get_ref().to_ascii_lowercase();
        if !(p.starts_with(&target.device.device) && p.contains(&target.device.package)) {
            diagnostics.push(
                Diagnostic::error(
                    "part-mismatch",
                    format!(
                        "part `{}` is not a {} in the {} package",
                        part.get_ref(),
                        target.device.device,
                        target.device.package
                    ),
                )
                .with_primary(part.span(), "")
                .with_help(format!(
                    "the {} uses {}; `part` may only change the speed or temperature grade",
                    target.board.name, target.board.part
                )),
            );
        }
    }

    let (ports, resolve_diags) = resolve(manifest, target);
    diagnostics.extend(resolve_diags);
    diagnostics.extend(checks::all(&ports, target));
    diagnostics.sort_by_key(|d| (d.primary.as_ref().map(|l| l.span.start), d.code));

    Report {
        target: Some(target),
        ports,
        diagnostics,
    }
}
