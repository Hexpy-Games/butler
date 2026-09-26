use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempDirectory {
    path: PathBuf,
}

impl TempDirectory {
    fn new(label: &str) -> Self {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "butler-source-check-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test directory");
        Self { path }
    }

    fn write(&self, relative: &str, contents: &[u8]) {
        let path = self.path.join(relative);
        fs::create_dir_all(path.parent().expect("test file parent")).expect("create parent");
        fs::write(path, contents).expect("write test source");
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn run_checker(root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_butler-source-check"))
        .arg(root)
        .output()
        .expect("run source checker")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn accepts_review_and_limit_sized_sources() {
    let temp = TempDirectory::new("accepted");
    temp.write("a.rs", "// review\n".repeat(400).as_bytes());
    temp.write("nested/b.rs", "// limit\n".repeat(500).as_bytes());

    let output = run_checker(&temp.path);

    assert!(output.status.success(), "{}", text(&output.stderr));
    let stdout = text(&output.stdout);
    assert!(stdout.contains("REVIEW a.rs lines=400 responsibility review required"));
    assert!(stdout.contains("REVIEW nested/b.rs lines=500 responsibility review required"));
    assert!(stdout.contains("SCANNED files=2"));
}

#[test]
fn rejects_source_over_limit() {
    let temp = TempDirectory::new("over-limit");
    temp.write("too-long.rs", "// line\n".repeat(501).as_bytes());

    let output = run_checker(&temp.path);

    assert!(!output.status.success());
    assert!(text(&output.stderr).contains("ERROR too-long.rs lines=501 exceeds 500-line limit"));
}

#[test]
fn scans_recursively_and_excludes_output_directories() {
    let temp = TempDirectory::new("recursive");
    temp.write("src/kept.rs", b"fn kept() {}\n");
    temp.write("target/generated.rs", "// ignored\n".repeat(501).as_bytes());
    temp.write(".git/internal.rs", "// ignored\n".repeat(501).as_bytes());

    let output = run_checker(&temp.path);

    assert!(output.status.success(), "{}", text(&output.stderr));
    let stdout = text(&output.stdout);
    assert!(stdout.contains("SOURCE src/kept.rs lines=1"));
    assert!(!stdout.contains("generated.rs"));
    assert!(stdout.contains("SCANNED files=1"));
}

#[test]
fn rejects_excess_arguments_with_usage() {
    let temp = TempDirectory::new("usage");
    temp.write("valid.rs", b"fn valid() {}\n");
    let output = Command::new(env!("CARGO_BIN_EXE_butler-source-check"))
        .arg(&temp.path)
        .arg("unexpected")
        .output()
        .expect("run source checker with excess argument");

    assert!(!output.status.success());
    assert!(text(&output.stderr).contains("usage: butler-source-check [ROOT]"));
}

#[test]
fn rejects_invalid_utf8_and_empty_source_trees() {
    let malformed = TempDirectory::new("invalid-utf8");
    malformed.write("bad.rs", &[0xff, 0xfe]);
    let malformed_output = run_checker(&malformed.path);
    assert!(!malformed_output.status.success());
    assert!(text(&malformed_output.stderr).contains("cannot read"));

    let empty = TempDirectory::new("empty");
    empty.write("README.md", b"no Rust here\n");
    let empty_output = run_checker(&empty.path);
    assert!(!empty_output.status.success());
    assert!(text(&empty_output.stderr).contains("no Rust files found"));
}

#[cfg(unix)]
#[test]
fn rejects_source_and_directory_symlinks() {
    use std::os::unix::fs::symlink;

    let source_link = TempDirectory::new("source-link");
    source_link.write("real.txt", b"fn hidden() {}\n");
    symlink(
        source_link.path.join("real.txt"),
        source_link.path.join("hidden.rs"),
    )
    .expect("create source symlink");
    let source_output = run_checker(&source_link.path);
    assert!(!source_output.status.success());
    assert!(text(&source_output.stderr).contains("source or directory symlink is not allowed"));

    let directory_link = TempDirectory::new("directory-link");
    directory_link.write("external/hidden.rs", b"fn hidden() {}\n");
    symlink(
        directory_link.path.join("external"),
        directory_link.path.join("linked"),
    )
    .expect("create directory symlink");
    let directory_output = run_checker(&directory_link.path);
    assert!(!directory_output.status.success());
    assert!(text(&directory_output.stderr).contains("source or directory symlink is not allowed"));
}
