//! Golden-file tests: every `examples/blinky/<board>` project must generate exactly
//! `tests/golden/blinky-<board>.<ext>`. Regenerate with
//! `UPDATE_GOLDEN=1 cargo test -p bitstream-constraints` and review the diff.

use std::fs;
use std::path::{Path, PathBuf};

use bitstream_boards::Database;
use bitstream_manifest::Manifest;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn generate(example: &Path) -> bitstream_constraints::Generated {
    let source = fs::read_to_string(example.join("bitstream.toml")).unwrap();
    let (manifest, _) = Manifest::parse(&source).unwrap_or_else(|e| panic!("{e:#?}"));
    let report = bitstream_rules::check(&manifest, Database::builtin());
    assert!(
        !report.has_errors(),
        "{}: {:#?}",
        example.display(),
        report.diagnostics
    );
    bitstream_constraints::generate(&manifest, report.target.unwrap(), &report.ports)
}

#[test]
fn blinky_examples_match_golden_files() {
    let examples = repo_root().join("examples/blinky");
    let golden_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let update = std::env::var_os("UPDATE_GOLDEN").is_some();

    let mut boards: Vec<PathBuf> = fs::read_dir(&examples)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("bitstream.toml").is_file())
        .collect();
    boards.sort();
    assert!(!boards.is_empty(), "no examples found");

    let mut mismatches = Vec::new();
    for example in boards {
        let board = example.file_name().unwrap().to_str().unwrap();
        let generated = generate(&example);
        let ext = Path::new(&generated.file_name).extension().unwrap();
        let golden = golden_dir.join(format!("blinky-{board}.{}", ext.to_str().unwrap()));
        if update {
            fs::write(&golden, &generated.contents).unwrap();
            continue;
        }
        let expected = fs::read_to_string(&golden)
            .unwrap_or_else(|e| panic!("{}: {e}; run with UPDATE_GOLDEN=1", golden.display()));
        if expected != generated.contents {
            mismatches.push(format!(
                "{}:\n--- expected\n{expected}\n--- generated\n{}",
                golden.display(),
                generated.contents
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn generation_is_deterministic() {
    let example = repo_root().join("examples/blinky/icebreaker");
    assert_eq!(generate(&example), generate(&example));
}

#[test]
fn xdc_differential_and_io_settings() {
    let source = r#"
[project]
name = "hdmi"
top = "hdmi"
board = "arty-a7-35"

[pins]
tmds = { signal = "jb[0]", io_standard = "TMDS_33" }
"btn[1]" = { signal = "btn[1]", pull = "down" }
dbg = { pin = "G13", io_standard = "LVCMOS33", slew = "fast", drive = 12 }
"#;
    let (manifest, _) = Manifest::parse(source).unwrap();
    let report = bitstream_rules::check(&manifest, Database::builtin());
    assert!(!report.has_errors(), "{:#?}", report.diagnostics);
    let generated =
        bitstream_constraints::generate(&manifest, report.target.unwrap(), &report.ports);
    let body: Vec<&str> = generated
        .contents
        .lines()
        .filter(|l| l.contains("get_ports"))
        .collect();
    assert_eq!(
        body,
        [
            "set_property -dict { PACKAGE_PIN C9 IOSTANDARD LVCMOS33 PULLTYPE PULLDOWN } [get_ports { btn[1] }]",
            "set_property -dict { PACKAGE_PIN G13 IOSTANDARD LVCMOS33 SLEW FAST DRIVE 12 } [get_ports { dbg }]",
            "set_property -dict { PACKAGE_PIN E15 IOSTANDARD TMDS_33 } [get_ports { tmds_p }]",
            "set_property -dict { PACKAGE_PIN E16 IOSTANDARD TMDS_33 } [get_ports { tmds_n }]",
        ]
    );
}
