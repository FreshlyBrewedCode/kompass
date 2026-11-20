use std::process::Command;

#[test]
fn prints_the_engine_version() {
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        format!("kompass {}", kompass_core::version())
    );
}

#[test]
fn rejects_unknown_arguments() {
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .arg("--nope")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn compile_needs_a_build_dir() {
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .arg("compile")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--build"));
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .args(["compile", "--build", "/nonexistent/kompass"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn compiles_and_describes_a_build() {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-village");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../compile/tests/fixtures/village/edges.parquet");
    std::fs::copy(fixture, dir.join("edges.parquet")).unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        "{\"schemaVersion\": 1, \"buildId\": \"build123\"}\n",
    )
    .unwrap();
    let run = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    };
    let build = dir.to_str().unwrap();
    assert!(run(&["compile", "--build", build]).contains("compiled build build123: 19 edges"));
    let info = run(&["info", "--build", build, "--snaps", "50"]);
    assert!(info.contains("19 edges"), "{info}");
    assert!(info.contains("50 queries, 50 found"), "{info}");
}
