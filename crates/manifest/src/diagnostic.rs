//! Diagnostics shared by every crate, plus a rustc-style terminal renderer.

use std::fmt::Write as _;
use std::ops::Range;

/// A byte range into a source file.
pub type Span = Range<usize>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warning,
    Note,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Note => "note",
        }
    }
}

/// A source annotation: a span plus an optional message shown next to the caret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub span: Span,
    pub message: String,
}

/// A single problem found in a manifest.
///
/// `code` is a stable kebab-case identifier (for example `bank-voltage`) that tools
/// and users can match on. Spans always refer to the manifest source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    pub primary: Option<Label>,
    pub secondary: Vec<Label>,
    pub help: Option<String>,
    pub notes: Vec<String>,
}

impl Diagnostic {
    pub fn new(severity: Severity, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            severity,
            code,
            message: message.into(),
            primary: None,
            secondary: Vec::new(),
            help: None,
            notes: Vec::new(),
        }
    }

    pub fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Severity::Error, code, message)
    }

    pub fn warning(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Severity::Warning, code, message)
    }

    pub fn with_primary(mut self, span: Span, message: impl Into<String>) -> Self {
        self.primary = Some(Label {
            span,
            message: message.into(),
        });
        self
    }

    pub fn with_secondary(mut self, span: Span, message: impl Into<String>) -> Self {
        self.secondary.push(Label {
            span,
            message: message.into(),
        });
        self
    }

    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }

    /// Render in the style of rustc:
    ///
    /// ```text
    /// error[bank-voltage]: LVDS_25 needs VCCO = 2.5 V but bank 35 is powered at 3.3 V
    ///   --> bitstream.toml:14:38
    ///    |
    /// 14 | lvds_in = { pin = "H16", io_standard = "LVDS_25" }
    ///    |                                        ^^^^^^^^^ requires 2.5 V
    ///    |
    ///    = help: ...
    /// ```
    pub fn render(&self, file_name: &str, source: &str) -> String {
        let mut labels: Vec<(&Label, bool)> = Vec::new();
        if let Some(p) = &self.primary {
            labels.push((p, true));
        }
        labels.extend(self.secondary.iter().map(|l| (l, false)));

        let positions: Vec<LineCol> = labels
            .iter()
            .map(|(l, _)| line_col(source, l.span.start))
            .collect();
        let gutter = positions.iter().map(|p| digits(p.line)).max().unwrap_or(1);
        let pad = " ".repeat(gutter);

        let mut out = String::new();
        let _ = writeln!(
            out,
            "{}[{}]: {}",
            self.severity.as_str(),
            self.code,
            self.message
        );
        match positions.first() {
            Some(pos) => {
                let _ = writeln!(out, "{pad}--> {file_name}:{}:{}", pos.line, pos.col);
            }
            None => {
                let _ = writeln!(out, "{pad}--> {file_name}");
            }
        }

        // Group labels by line, keeping lines in source order.
        let mut by_line: Vec<(usize, LineLabels<'_>)> = Vec::new();
        for ((label, primary), pos) in labels.iter().zip(&positions) {
            match by_line.iter_mut().find(|(line, _)| *line == pos.line) {
                Some((_, v)) => v.push((label, *primary, *pos)),
                None => by_line.push((pos.line, vec![(label, *primary, *pos)])),
            }
        }
        by_line.sort_by_key(|(line, _)| *line);
        for (_, labels) in &mut by_line {
            labels.sort_by_key(|(_, _, pos)| pos.col);
        }

        if !by_line.is_empty() {
            let _ = writeln!(out, "{pad} |");
        }
        let mut prev_line = None;
        for (line_no, line_labels) in &by_line {
            if let Some(prev) = prev_line
                && line_no - prev > 1
            {
                let _ = writeln!(out, "{}...", " ".repeat(gutter.saturating_sub(1)));
            }
            prev_line = Some(*line_no);
            let text = source_line(source, *line_no);
            let _ = writeln!(out, "{line_no:>gutter$} | {text}");
            for (label, primary, pos) in line_labels {
                let width = caret_width(text, pos.col, &label.span);
                let marker = if *primary { "^" } else { "-" }.repeat(width);
                let indent = " ".repeat(display_width(&text[..col_byte(text, pos.col)]));
                let msg = if label.message.is_empty() {
                    String::new()
                } else {
                    format!(" {}", label.message)
                };
                let _ = writeln!(out, "{pad} | {indent}{marker}{msg}");
            }
        }

        if self.help.is_some() || !self.notes.is_empty() {
            let _ = writeln!(out, "{pad} |");
        }
        for note in &self.notes {
            let _ = writeln!(out, "{pad} = note: {note}");
        }
        if let Some(help) = &self.help {
            let _ = writeln!(out, "{pad} = help: {help}");
        }
        out
    }
}

/// Labels on one source line: `(label, is_primary, position)`.
type LineLabels<'a> = Vec<(&'a Label, bool, LineCol)>;

/// 1-based line and column (column counted in characters).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineCol {
    pub line: usize,
    pub col: usize,
}

/// Convert a byte offset into a 1-based line and column.
pub fn line_col(source: &str, offset: usize) -> LineCol {
    let offset = offset.min(source.len());
    let before = &source[..floor_char_boundary(source, offset)];
    let line = before.matches('\n').count() + 1;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let col = before[line_start..].chars().count() + 1;
    LineCol { line, col }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn source_line(source: &str, line: usize) -> &str {
    source
        .lines()
        .nth(line - 1)
        .unwrap_or("")
        .trim_end_matches('\r')
}

fn col_byte(text: &str, col: usize) -> usize {
    text.char_indices()
        .nth(col - 1)
        .map_or(text.len(), |(i, _)| i)
}

fn display_width(s: &str) -> usize {
    s.chars().map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

fn caret_width(line_text: &str, col: usize, span: &Span) -> usize {
    let start = col_byte(line_text, col);
    let len = span.end.saturating_sub(span.start);
    let available = &line_text[start..];
    // Spans that run past the end of the line are clipped to the line.
    let end = floor_char_boundary(available, len.min(available.len()));
    available[..end].chars().count().max(1)
}

fn digits(mut n: usize) -> usize {
    let mut d = 1;
    while n >= 10 {
        n /= 10;
        d += 1;
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_col_counts_from_one() {
        let src = "a = 1\nbb = 2\n";
        assert_eq!(line_col(src, 0), LineCol { line: 1, col: 1 });
        assert_eq!(line_col(src, 6), LineCol { line: 2, col: 1 });
        assert_eq!(line_col(src, 11), LineCol { line: 2, col: 6 });
    }

    #[test]
    fn renders_rustc_style() {
        let src = "[pins]\nled = { pin = \"Z99\" }\n";
        let start = src.find("\"Z99\"").unwrap();
        let d = Diagnostic::error("unknown-pin", "package pin `Z99` does not exist")
            .with_primary(start..start + 5, "not a pin on xc7a35tcpg236")
            .with_help("check the package pinout");
        let expected = "\
error[unknown-pin]: package pin `Z99` does not exist
 --> bitstream.toml:2:15
  |
2 | led = { pin = \"Z99\" }
  |               ^^^^^ not a pin on xc7a35tcpg236
  |
  = help: check the package pinout
";
        assert_eq!(d.render("bitstream.toml", src), expected);
    }

    #[test]
    fn renders_secondary_labels_on_other_lines() {
        let src = "[pins]\na = { pin = \"W5\" }\nb = { pin = \"W5\" }\n";
        let first = src.find("\"W5\"").unwrap();
        let second = src.rfind("\"W5\"").unwrap();
        let d = Diagnostic::error("duplicate-pin", "pin W5 is assigned twice")
            .with_primary(second..second + 4, "second use")
            .with_secondary(first..first + 4, "first use");
        let out = d.render("m.toml", src);
        assert!(out.contains(" --> m.toml:3:13"), "{out}");
        assert!(out.contains("2 | a = { pin = \"W5\" }\n  |             ---- first use"));
        assert!(out.contains("3 | b = { pin = \"W5\" }\n  |             ^^^^ second use"));
    }
}
