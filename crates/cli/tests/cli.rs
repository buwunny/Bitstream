//! End-to-end tests of the `bitstream` binary on the examples.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn examples() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples")
}

/// Run `bitstream <args>` from the examples directory.
fn bitstream(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bitstream"))
        .args(args)
        .current_dir(examples())
        .output()
        .unwrap()
}

#[test]
fn blinky_examples_pass_check() {
    for board in ["basys3", "arty-a7-35", "icebreaker"] {
        let out = bitstream(&["check", "--manifest-path", &format!("blinky/{board}")]);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "{board}: {stderr}");
        assert!(!stderr.contains("warning"), "{board}: {stderr}");
    }
}

#[test]
fn broken_lvds_example_fails_with_a_clear_message() {
    let out = bitstream(&["check", "--manifest-path", "broken-lvds"]);
    assert!(!out.status.success());
    let expected = "\
error[bank-voltage]: LVDS_25 needs VCCO = 2.5 V, but bank 15 is powered at 3.3 V
  --> broken-lvds/bitstream.toml:17:66
   |
17 | lvds_out = { signal = \"jb[0]\", signal_n = \"jb[1]\", io_standard = \"LVDS_25\" }
   |                       ------- pin E15 is in bank 15 (3.3 V)
   |                                                                  ^^^^^^^^^ requires 2.5 V
   |
   = help: differential IO standards for a 3.3 V bank: TMDS_33; the Digilent Arty A7-35 has no bank powered at 2.5 V

error: could not check `lvds_tx` due to 1 previous error
";
    // Paths are printed with the platform separator.
    let stderr = String::from_utf8_lossy(&out.stderr).replace('\\', "/");
    assert_eq!(stderr, expected);
}

#[test]
fn constraints_refuses_a_broken_project() {
    let out = bitstream(&["constraints", "--manifest-path", "broken-lvds"]);
    assert!(!out.status.success());
    assert!(!examples().join("broken-lvds/build").exists());
}

#[test]
fn constraints_writes_into_build_dir() {
    let dir = std::env::temp_dir().join(format!("bitstream-cli-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let src = examples().join("blinky/icebreaker/bitstream.toml");
    std::fs::copy(src, dir.join("bitstream.toml")).unwrap();

    let out = bitstream(&["constraints", "--manifest-path", dir.to_str().unwrap()]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let pcf = std::fs::read_to_string(dir.join("build/blinky.pcf")).unwrap();
    assert!(pcf.contains("set_io clk 35\n"), "{pcf}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn init_writes_a_manifest_that_checks() {
    let dir = std::env::temp_dir().join(format!("bitstream-init-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let out = bitstream(&[
        "init",
        "--board",
        "basys3",
        "--name",
        "demo",
        dir.to_str().unwrap(),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out = bitstream(&["check", "--manifest-path", dir.to_str().unwrap()]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let again = bitstream(&["init", "--board", "basys3", dir.to_str().unwrap()]);
    assert!(!again.status.success(), "init must not overwrite");
    let typo = bitstream(&["init", "--board", "basys", "x"]);
    assert!(String::from_utf8_lossy(&typo.stderr).contains("did you mean `basys3`?"));
    std::fs::remove_dir_all(&dir).unwrap();
}
