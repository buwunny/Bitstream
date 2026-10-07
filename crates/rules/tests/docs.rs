//! The full example in docs/manifest.md must stay valid.

use bitstream_boards::Database;
use bitstream_manifest::Manifest;

#[test]
fn manifest_reference_example_passes_check() {
    let doc = include_str!("../../../docs/manifest.md").replace("\r\n", "\n");
    let section = &doc[doc.find("## Full example").expect("section exists")..];
    let start = section.find("```toml\n").expect("toml block") + "```toml\n".len();
    let example = &section[start..start + section[start..].find("```").unwrap()];

    let (manifest, warnings) = Manifest::parse(example).unwrap_or_else(|e| panic!("{e:#?}"));
    let report = bitstream_rules::check(&manifest, Database::builtin());
    let rendered: Vec<String> = warnings
        .iter()
        .chain(&report.diagnostics)
        .map(|d| d.render("docs/manifest.md", example))
        .collect();
    assert!(rendered.is_empty(), "{}", rendered.join("\n"));
}
