//! Bind memory qualification to the source revision actually used for this binary.
//! Dirty development builds remain usable, but cannot claim a qualification commit.

use std::{env, path::Path, process::Command};

const SCOPE: &[&str] = &[
    "packages/butler-agent/rust",
    "packages/butler-agent/resources",
    "packages/butler-app/client/electron",
    "packages/butler-app/scripts/release",
];

fn output(root: &Path, arguments: &[&str]) -> Option<String> {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .output()
        .ok()?;
    result
        .status
        .success()
        .then(|| String::from_utf8(result.stdout).ok())?
}

fn main() {
    println!("cargo:rerun-if-env-changed=BUTLER_MEMORY_IMPLEMENTATION_COMMIT");
    for path in [
        "src",
        "build.rs",
        "Cargo.toml",
        "../Cargo.toml",
        "../Cargo.lock",
        "../rust-toolchain.toml",
        "../scripts",
        "../../resources",
        "../../../butler-app/client/electron",
        "../../../butler-app/scripts/release",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let Ok(manifest) = env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let manifest = Path::new(&manifest);
    let Some(root) = output(manifest, &["rev-parse", "--show-toplevel"]) else {
        return;
    };
    let root = root.trim();
    let root = Path::new(root);
    for git_path in ["HEAD", "index"] {
        if let Some(path) = output(root, &["rev-parse", "--git-path", git_path]) {
            let path = Path::new(path.trim());
            let path = if path.is_absolute() {
                path.to_owned()
            } else {
                root.join(path)
            };
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    let mut status = Command::new("git");
    status.arg("-C").arg(root).args([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
    ]);
    status.args(SCOPE);
    let Ok(status) = status.output() else {
        return;
    };
    if !status.status.success() || !status.stdout.is_empty() {
        return;
    }
    let Some(head) = output(root, &["rev-parse", "HEAD"]) else {
        return;
    };
    let head = head.trim();
    if !(40..=64).contains(&head.len()) || !head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return;
    }
    if let Some(requested) = env::var_os("BUTLER_MEMORY_IMPLEMENTATION_COMMIT")
        && requested.to_string_lossy().trim() != head
    {
        return;
    }
    println!("cargo:rustc-env=BUTLER_MEMORY_VERIFIED_COMMIT={head}");
}
