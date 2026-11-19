//! `kompass`: the engine on the command line. For now it only knows its version.

use std::process::ExitCode;

const USAGE: &str = "usage: kompass [--version | --help]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("--version" | "-V" | "version") => {
            println!("kompass {}", kompass_core::version());
            ExitCode::SUCCESS
        }
        Some("--help" | "-h" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("kompass: unknown argument `{other}`\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
