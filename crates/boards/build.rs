//! Embeds every TOML file under the repository's `boards/` directory into the crate,
//! so adding a board is a data-only change.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let data_dir = manifest_dir.join("../../boards").canonicalize().unwrap();
    println!("cargo:rerun-if-changed={}", data_dir.display());

    let mut files = Vec::new();
    collect(&data_dir, &mut files);
    files.sort();

    let mut out = String::from("&[\n");
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
        let rel = file.strip_prefix(&data_dir).unwrap();
        let rel = rel.to_str().unwrap().replace('\\', "/");
        let _ = writeln!(out, "    ({rel:?}, include_str!({:?})),", file.display());
    }
    out.push(']');

    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("embedded.rs");
    fs::write(out_path, out).unwrap();
}

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            println!("cargo:rerun-if-changed={}", path.display());
            collect(&path, files);
        } else if path.extension().is_some_and(|e| e == "toml") {
            files.push(path);
        }
    }
}
