//! The native PDF printer reuses Electron's document HTML and CSS renderer.
use std::{env, path::PathBuf, process::Command};

fn main() {
    if env::var_os("CARGO_FEATURE_CEF").is_none() {
        return;
    }
    let ui = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../butler-app/client/ui");
    println!("cargo:rerun-if-changed={}", ui.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        ui.join("native-document-export.ts").display()
    );
    let Some(out) = env::var_os("OUT_DIR") else {
        std::process::exit(1);
    };
    let result = Command::new("bun")
        .arg(ui.join("native-document-export.ts"))
        .arg(PathBuf::from(out).join("document-export"))
        .status();
    if !result.is_ok_and(|status| status.success()) {
        eprintln!("native PDF renderer build failed (requires the existing Bun/UI dependencies)");
        std::process::exit(1);
    }
}
