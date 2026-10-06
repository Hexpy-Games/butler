//! Bind memory qualification to the source revision actually used for this binary.
//! Dirty development builds remain usable, but cannot claim a qualification commit.

use std::{env, path::Path, process::Command};

#[path = "../butler-platform/build_support.rs"]
mod build_support;

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
    if let Err(error) = build_support::embed_application_manifest() {
        eprintln!("cannot embed agent application manifest: {error}");
        std::process::exit(1);
    }
    println!("cargo:rerun-if-env-changed=BUTLER_MEMORY_IMPLEMENTATION_COMMIT");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
    let package_version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.1.0".into());
    let release_version = env::var("GITHUB_REF_NAME")
        .ok()
        .and_then(|tag| version_from_tag(&tag))
        .unwrap_or_else(|| format!("{package_version}-dev"));
    println!("cargo:rustc-env=BUTLER_RELEASE_VERSION={release_version}");
    for path in [
        "src",
        "../butler-agent/src",
        "../butler-agent/Cargo.toml",
        "build.rs",
        "Cargo.toml",
        "../../Cargo.toml",
        "../../Cargo.lock",
        "../../rust-toolchain.toml",
        "../../scripts",
        "../../../resources",
        "../../../../butler-app/client/electron",
        "../../../../butler-app/scripts/release",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rustc-env=BUTLER_BUILD_ID=source-archive");
    let Ok(manifest) = env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let manifest = Path::new(&manifest);
    let Some(root) = output(manifest, &["rev-parse", "--show-toplevel"]) else {
        return;
    };
    let root = root.trim();
    let root = Path::new(root);
    emit_build_id(root);
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

fn version_from_tag(tag: &str) -> Option<String> {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    semver::Version::parse(version).ok()?;
    Some(version.to_owned())
}

fn emit_build_id(root: &Path) {
    let revision =
        output(root, &["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = output(root, &["status", "--porcelain"]).is_some_and(|s| !s.trim().is_empty());
    println!(
        "cargo:rustc-env=BUTLER_BUILD_ID={}{}",
        revision.trim(),
        if dirty { ".dirty" } else { "" }
    );
}
