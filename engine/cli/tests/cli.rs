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
