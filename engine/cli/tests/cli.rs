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

/// The generated JSON Schemas and TypeScript types in `web/src/engine/generated/` match the Rust
/// types (`bun run gen:engine` rewrites them).
#[test]
fn the_generated_types_are_up_to_date() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/engine/generated");
    for (name, want) in kompass_core::schema::files() {
        let got = std::fs::read_to_string(dir.join(name)).unwrap_or_default();
        assert!(
            got == want,
            "web/src/engine/generated/{name} is stale: run `bun run gen:engine`"
        );
    }
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .args(["schema", "--check", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn prints_the_profile_schema_catalogue_and_presets() {
    let run = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let schema = run(&["profile", "schema"]);
    assert_eq!(schema["title"], "Profile");
    let catalogue = run(&["profile", "catalogue"]);
    assert!(catalogue["preferences"].as_array().unwrap().len() > 30);
    let presets = run(&["profile", "presets"]);
    assert_eq!(presets[0]["id"], "gravel_explorer");
}

#[test]
fn routes_on_the_fixture_region_as_geojson() {
    let build = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/region");
    let out_file = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("fixture-route.geojson");
    // two grid nodes of the fixture (e2e/fixtures/build-region.ts): 6 × 6, 0.0045° apart
    let node = |i: f64, j: f64| format!("{},{}", -0.01125 + i * 0.0045, -0.01125 + j * 0.0045);
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .args([
            "route",
            "--build",
            build.to_str().unwrap(),
            "--profile",
            "Gravel explorer",
        ])
        .args([
            "--from",
            &node(1.0, 1.0),
            "--via",
            &node(3.0, 1.0),
            "--to",
            &node(3.0, 0.0),
        ])
        .args(["--out", out_file.to_str().unwrap(), "--segments"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains(" km, +"));
    let gj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out_file).unwrap()).unwrap();
    assert_eq!(gj["type"], "FeatureCollection");
    let features = gj["features"].as_array().unwrap();
    assert_eq!(features[0]["geometry"]["type"], "LineString");
    assert_eq!(features[0]["properties"]["legs"].as_array().unwrap().len(), 2);
    assert!(
        features
            .iter()
            .skip(1)
            .all(|f| f["properties"]["kind"] == "segment")
    );
    // a profile that does not exist
    let out = Command::new(env!("CARGO_BIN_EXE_kompass"))
        .args(["route", "--build", build.to_str().unwrap(), "--profile", "nope"])
        .args(["--from", "0,0", "--to", "0,0"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}
