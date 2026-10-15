use std::collections::BTreeMap;

use super::{manifest, source, workspace_packages};

fn found(contents: &str) -> Vec<(usize, String)> {
    source(contents)
        .unwrap()
        .into_iter()
        .map(|finding| (finding.line, finding.code))
        .collect()
}

fn declared(contents: &str, workspace: &BTreeMap<String, String>) -> Vec<(usize, String)> {
    manifest(contents, workspace)
        .unwrap()
        .into_iter()
        .map(|finding| (finding.line, finding.code))
        .collect()
}

fn expect(pairs: &[(usize, &str)]) -> Vec<(usize, String)> {
    pairs
        .iter()
        .map(|(line, code)| (*line, (*code).to_owned()))
        .collect()
}

#[test]
fn flags_os_selection_apis_modes_and_home_reads() {
    let contents = "\
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg_attr(target_os = \"macos\", expect(dead_code))]
fn a() { if cfg!(windows) {} }
#[cfg(all(test, not(target_family = \"wasm\")))]
use std::{io, os::fd::AsRawFd};
fn b() { nix::unistd::getpid(); let _ = libc::O_NOFOLLOW; }
fn c() { set(0o600); }
fn d() { std::env::var_os(\"HOME\"); env::var(\"USERPROFILE\"); std::env::home_dir(); }
";
    assert_eq!(
        found(contents),
        expect(&[
            (1, "cfg(unix)"),
            (2, "os::unix::fs::PermissionsExt"),
            (3, "cfg_attr(target_os=\"macos\",expect(dead_code))"),
            (4, "cfg!(windows)"),
            (5, "cfg(all(test,not(target_family=\"wasm\")))"),
            (6, "os::fd::AsRawFd"),
            (7, "nix::unistd::getpid"),
            (7, "libc::O_NOFOLLOW"),
            (8, "0o600"),
            (9, "var_os(\"HOME\")"),
            (9, "var(\"USERPROFILE\")"),
            (9, "env::home_dir"),
        ])
    );
}

#[test]
fn flags_grouped_imports_of_os_modules() {
    let contents = "\
use std::os::{unix::fs::MetadataExt};
use std::os::{self, windows::io::AsRawHandle};
use std::os::{raw::c_int};
";
    assert_eq!(
        found(contents),
        expect(&[
            (1, "os::{unix::fs::MetadataExt}"),
            (2, "os::{self,windows::io::AsRawHandle}"),
        ])
    );
}

#[test]
fn flags_renames_of_std_os_but_not_casts() {
    let contents = "\
use std::os as o;
use std::{io, os as system};
fn a(os: u8) -> u32 { os as u32 }
";
    assert_eq!(
        found(contents),
        expect(&[(1, "os as o"), (2, "os as system")])
    );
}

#[test]
fn flags_renamed_and_extern_binding_crates() {
    let contents = "\
use nix as n;
extern crate libc as c;
extern crate libc;
use {rustix as r};
use ::libproc::proc_pid::name;
";
    assert_eq!(
        found(contents),
        expect(&[
            (1, "nix as n"),
            (2, "libc as c"),
            (3, "libc"),
            (4, "rustix as r"),
            (5, "libproc::proc_pid::name"),
        ])
    );
}

#[test]
fn flags_the_os_constants_of_std_env() {
    let contents = "\
fn a() { std::env::consts::OS; env::consts::FAMILY; }
use std::env::consts::{ARCH, OS};
use std::env::consts::*;
use std::env::consts as c;
fn b() { std::env::consts::ARCH; std::env::consts::EXE_SUFFIX; }
";
    assert_eq!(
        found(contents),
        expect(&[
            (1, "consts::OS"),
            (1, "consts::FAMILY"),
            (2, "consts::{ARCH,OS}"),
            (3, "consts::*"),
            (4, "consts as c"),
        ])
    );
}

#[test]
fn ignores_comments_strings_and_neutral_code() {
    let contents = "\
// #[cfg(unix)] std::os::unix nix::errno 0o600 var_os(\"HOME\") consts::OS
/// Uses `std::os::unix`, `use nix as n` and `cfg(windows)`.
#[cfg(test)]
#[cfg(any(test, feature = \"test-support\"))]
fn a() { let text = \"#[cfg(unix)] 0o600\"; bytes.windows(2); }
fn b() { env::var(\"PATH\"); user_dirs::home_dir(); let unix = 1; let mode = 0x600; }
use std::os::raw::c_int;
fn c(consts: Table) { consts.get(\"OS\"); }
";
    assert_eq!(found(contents), [] as [(usize, std::string::String); 0]);
}

#[test]
fn manifests_flag_os_tables_and_binding_crates_however_spelled() {
    let contents = "\
[dependencies]
serde.workspace = true
x = { package = \"nix\", version = \"0.30\" }
inherited = { workspace = true }
[dependencies.libc]
version = \"0.2\"
[dev-dependencies]
rustix = \"1\"
[target.'cfg(unix)'.dependencies]
nix.workspace = true
[target.x86_64-pc-windows-msvc.dependencies]
windows-sys = \"0.60\"
[target.'cfg(target_os = \"macos\")'.build-dependencies]
libproc = { workspace = true }
[target.'cfg(feature = \"x\")'.dependencies]
nixie = \"1\"
";
    let workspace = workspace_packages(
        "[workspace.dependencies]\ninherited = { package = \"libproc\", version = \"0.14\" }\n",
    )
    .unwrap();
    assert_eq!(
        declared(contents, &workspace),
        expect(&[
            (3, "dependency x = nix"),
            (4, "dependency inherited = libproc"),
            (5, "dependency libc"),
            (8, "dependency rustix"),
            (9, "[target.'cfg(unix)']"),
            (10, "dependency nix"),
            (11, "[target.'x86_64-pc-windows-msvc']"),
            (13, "[target.'cfg(target_os = \"macos\")']"),
            (14, "dependency libproc"),
        ])
    );
}
