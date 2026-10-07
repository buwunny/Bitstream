//! The `bitstream` command-line tool.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use bitstream_boards::Database;
use bitstream_manifest::{Diagnostic, MANIFEST_FILE, Manifest, Severity};
use bitstream_rules::Report;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "bitstream", version, about = "BITSTREAM.sh FPGA toolkit")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a new bitstream.toml for a board.
    Init {
        /// Board id, for example `basys3`.
        #[arg(long)]
        board: String,
        /// Project name; defaults to the directory name.
        #[arg(long)]
        name: Option<String>,
        /// Directory to create the project in.
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Check the manifest and pin assignments against the board.
    Check(ManifestArgs),
    /// Generate vendor constraint files into the build directory.
    Constraints(ManifestArgs),
    /// Run the vendor build (not implemented yet).
    Build(ManifestArgs),
    /// Run cocotb simulations (not implemented yet).
    Sim(ManifestArgs),
}

#[derive(clap::Args)]
struct ManifestArgs {
    /// Path to bitstream.toml, or a directory containing one.
    #[arg(long, default_value = ".")]
    manifest_path: PathBuf,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Init { board, name, path } => init(&board, name, &path),
        Command::Check(args) => check(&args).map(|_| ()),
        Command::Constraints(args) => constraints(&args),
        Command::Build(_) => not_yet("build", "vendor builds"),
        Command::Sim(_) => not_yet("sim", "simulation"),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Reported) => ExitCode::FAILURE,
        Err(Failure::Message(m)) => {
            eprintln!("error: {m}");
            ExitCode::FAILURE
        }
    }
}

enum Failure {
    /// Diagnostics were already printed.
    Reported,
    Message(String),
}

impl From<String> for Failure {
    fn from(m: String) -> Self {
        Failure::Message(m)
    }
}

fn not_yet(command: &str, what: &str) -> Result<(), Failure> {
    Err(format!(
        "`bitstream {command}` is not implemented yet; {what} are planned (see ROADMAP.md)"
    )
    .into())
}

/// A manifest loaded from disk.
struct Loaded {
    path: PathBuf,
    display: String,
    source: String,
}

fn load(args: &ManifestArgs) -> Result<Loaded, Failure> {
    let path = if args.manifest_path.is_dir() {
        args.manifest_path.join(MANIFEST_FILE)
    } else {
        args.manifest_path.clone()
    };
    let source = fs::read_to_string(&path)
        .map_err(|e| format!("could not read `{}`: {e}", path.display()))?;
    let display = path
        .strip_prefix(".")
        .unwrap_or(&path)
        .display()
        .to_string();
    Ok(Loaded {
        path,
        display,
        source,
    })
}

fn print_diagnostics(loaded: &Loaded, diags: &[Diagnostic]) {
    for d in diags {
        eprintln!("{}", d.render(&loaded.display, &loaded.source));
    }
}

fn summary(diags: &[Diagnostic]) -> (usize, usize) {
    let errors = diags
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .count();
    let warnings = diags
        .iter()
        .filter(|d| d.severity == Severity::Warning)
        .count();
    (errors, warnings)
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("{n} {word}")
    } else {
        format!("{n} {word}s")
    }
}

/// A manifest that passed all checks.
struct Checked {
    loaded: Loaded,
    manifest: Manifest,
    report: Report<'static>,
}

/// Parse and check; print diagnostics. Fails if there are any errors.
fn check(args: &ManifestArgs) -> Result<Checked, Failure> {
    let loaded = load(args)?;
    let (manifest, mut diags) = match Manifest::parse(&loaded.source) {
        Ok(ok) => ok,
        Err(errors) => {
            print_diagnostics(&loaded, &errors);
            let (e, _) = summary(&errors);
            eprintln!(
                "error: could not parse `{}` due to {}",
                loaded.display,
                plural(e, "previous error")
            );
            return Err(Failure::Reported);
        }
    };
    let report = bitstream_rules::check(&manifest, Database::builtin());
    diags.extend(report.diagnostics.iter().cloned());
    print_diagnostics(&loaded, &diags);

    let (errors, warnings) = summary(&diags);
    let name = manifest.project.name.get_ref();
    if errors > 0 {
        let mut msg = format!(
            "error: could not check `{name}` due to {}",
            plural(errors, "previous error")
        );
        if warnings > 0 {
            msg.push_str(&format!("; {} emitted", plural(warnings, "warning")));
        }
        eprintln!("{msg}");
        return Err(Failure::Reported);
    }
    let board = &manifest.project.board;
    let pins = manifest.pins.len();
    let tail = if warnings > 0 {
        format!(" with {}", plural(warnings, "warning"))
    } else {
        String::new()
    };
    eprintln!(
        "    Checked `{name}` for {}: {}{tail}",
        board.get_ref(),
        plural(pins, "pin assignment")
    );
    Ok(Checked {
        loaded,
        manifest,
        report,
    })
}

fn constraints(args: &ManifestArgs) -> Result<(), Failure> {
    let Checked {
        loaded,
        manifest,
        report,
    } = check(args)?;
    let target = report
        .target
        .expect("check succeeded, so the board is known");
    let generated = bitstream_constraints::generate(&manifest, target, &report.ports);

    let root = loaded.path.parent().unwrap_or(Path::new("."));
    let out_dir = root.join(
        manifest
            .build
            .as_ref()
            .and_then(|b| b.out_dir.as_ref())
            .map_or("build", |d| d.get_ref().as_str()),
    );
    fs::create_dir_all(&out_dir)
        .map_err(|e| format!("could not create `{}`: {e}", out_dir.display()))?;
    let out = out_dir.join(&generated.file_name);
    fs::write(&out, &generated.contents)
        .map_err(|e| format!("could not write `{}`: {e}", out.display()))?;
    eprintln!(
        "     Wrote {}",
        out.strip_prefix(".").unwrap_or(&out).display()
    );
    Ok(())
}

fn init(board_id: &str, name: Option<String>, path: &Path) -> Result<(), Failure> {
    let db = Database::builtin();
    let Some(target) = db.target(board_id) else {
        let ids: Vec<&str> = db.boards().map(|b| b.id.as_str()).collect();
        let hint = match bitstream_rules::did_you_mean(board_id, ids.iter().copied()) {
            Some(s) => format!("did you mean `{s}`?"),
            None => format!("known boards: {}", ids.join(", ")),
        };
        return Err(format!("unknown board `{board_id}`; {hint}").into());
    };
    let manifest_path = path.join(MANIFEST_FILE);
    if manifest_path.exists() {
        return Err(format!("`{}` already exists", manifest_path.display()).into());
    }
    let name = match name {
        Some(n) => n,
        None => {
            let abs = fs::canonicalize(path)
                .map_err(|e| format!("could not open `{}`: {e}", path.display()))?;
            abs.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.replace(['-', ' ', '.'], "_"))
                .ok_or_else(|| "could not derive a project name; pass --name".to_string())?
        }
    };

    let mut text = format!(
        "[project]\nname = \"{name}\"\ntop = \"{name}\"\nboard = \"{board_id}\"\n\n\
         [sources]\nfiles = [\"rtl/*.v\", \"rtl/*.sv\", \"rtl/*.vhd\"]\n\n\
         [pins]\n# Map top-level ports to board signals or package pins, for example:\n"
    );
    let clocks = target.board.signals.iter().filter(|(_, s)| s.clock);
    for (signal, _) in clocks.take(1) {
        text.push_str(&format!("# clk = {{ signal = \"{signal}\" }}\n"));
    }
    text.push_str(&format!(
        "# led = {{ signals = [\"...\", \"...\"] }}\n\
         # Board signals are listed in boards/{board_id}.toml in the BITSTREAM.sh repository.\n"
    ));

    fs::create_dir_all(path).map_err(|e| format!("could not create `{}`: {e}", path.display()))?;
    fs::write(&manifest_path, text)
        .map_err(|e| format!("could not write `{}`: {e}", manifest_path.display()))?;
    eprintln!(
        "   Created `{name}` for the {} ({})",
        target.board.name,
        manifest_path.display()
    );
    Ok(())
}
