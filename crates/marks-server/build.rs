use std::fs;
use std::path::Path;
use std::process::Command;

fn quoted_field(line: &str, field: &str) -> Option<String> {
    let marker = format!("{field} = \"");
    let start = line.find(&marker)? + marker.len();
    let tail = &line[start..];
    Some(tail[..tail.find('"')?].to_owned())
}

fn build_revision() -> String {
    match std::env::var("MARKS_BUILD_REVISION") {
        Ok(value) if value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            value.to_ascii_lowercase()
        }
        Ok(_) => panic!("MARKS_BUILD_REVISION must be exactly 40 hexadecimal characters"),
        Err(std::env::VarError::NotPresent) => "development".to_owned(),
        Err(error) => panic!("cannot read MARKS_BUILD_REVISION: {error}"),
    }
}

fn git_source_dirty(workspace: &Path) -> Option<bool> {
    let output = Command::new("git")
        .args([
            "-C",
            workspace.to_str()?,
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--",
            ".",
        ])
        .output()
        .ok()?;
    output.status.success().then_some(!output.stdout.is_empty())
}

fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-env-changed=MARKS_BUILD_REVISION");
    println!("cargo:rerun-if-env-changed=MARKS_SOURCE_DIRTY");
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .expect("Cargo supplies CARGO_MANIFEST_DIR");
    let workspace = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("marks-server lives under the workspace crates directory");
    let manifest = fs::read_to_string("Cargo.toml").expect("read marks-server Cargo.toml");
    let engine_revision = manifest
        .lines()
        .find(|line| line.trim_start().starts_with("esbt = {"))
        .and_then(|line| quoted_field(line, "rev"))
        .filter(|revision| {
            revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .expect("the esbt dependency must have one exact 40-character rev");
    let build_revision = build_revision();
    let declared_dirty =
        std::env::var("MARKS_SOURCE_DIRTY")
            .ok()
            .map(|value| match value.as_str() {
                "0" => false,
                "1" => true,
                _ => panic!("MARKS_SOURCE_DIRTY must be exactly 0 or 1"),
            });
    if build_revision != "development" && declared_dirty.is_none() {
        panic!("a release MARKS_BUILD_REVISION requires an explicit MARKS_SOURCE_DIRTY");
    }
    let observed_dirty = git_source_dirty(workspace);
    if declared_dirty == Some(false) && observed_dirty == Some(true) {
        panic!("MARKS_SOURCE_DIRTY=0 contradicts the dirty Git checkout");
    }
    let source_dirty = declared_dirty.or(observed_dirty).unwrap_or(true);
    println!("cargo:rustc-env=MARKS_ESBT_REVISION={engine_revision}");
    println!("cargo:rustc-env=MARKS_BUILD_REVISION={build_revision}");
    println!(
        "cargo:rustc-env=MARKS_SOURCE_DIRTY={}",
        if source_dirty { "1" } else { "0" }
    );
}
