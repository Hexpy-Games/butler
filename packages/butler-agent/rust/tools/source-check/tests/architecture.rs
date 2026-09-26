use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "butler-boundaries-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("agent/src")).unwrap();
        Self(path)
    }

    fn write(&self, name: &str, source: &str) {
        let path = self.0.join("agent/src").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }

    fn check(&self, succeeds: bool) -> String {
        let output = Command::new(env!("CARGO_BIN_EXE_butler-source-check"))
            .arg(&self.0)
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.success(), succeeds, "{text}");
        text
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn facade_imports_and_test_only_reverse_edges_are_distinct() {
    let f = Fixture::new();
    f.write("lib.rs", "mod models; mod btcc;");
    f.write(
        "models.rs",
        "use crate::{btcc::{Thing as Contract}}; fn run(_: Contract) {}",
    );
    f.write("btcc.rs", "pub struct Thing; #[cfg(test)] mod tests { use crate::models; } #[cfg(all(test, unix))] mod absent_test_file;");
    let output = f.check(true);
    assert!(output.contains("DEPENDENCY models -> btcc"));
    assert!(!output.contains("DEPENDENCY btcc -> models"));
}

#[test]
fn rejects_actual_child_access_through_grouped_and_renamed_imports() {
    let f = Fixture::new();
    f.write("lib.rs", "mod models; mod btcc;");
    f.write("models.rs", "use crate::btcc::{inner::Thing as Contract};");
    f.write("btcc.rs", "pub mod inner { pub struct Thing; }");
    assert!(
        f.check(false)
            .contains("cross-domain child access btcc::inner::Thing")
    );
}

#[test]
fn normalizes_relative_paths_and_reports_cycles() {
    let f = Fixture::new();
    f.write("lib.rs", "mod models; mod btcc;");
    f.write("models.rs", "use super::btcc::Thing; pub struct Model;");
    f.write("btcc.rs", "mod child; pub struct Thing;");
    f.write(
        "btcc/child.rs",
        "type Example = super::super::models::Model;",
    );
    let output = f.check(false);
    assert!(output.contains("dependency btcc -> models is not allowed"));
    assert!(output.contains("domain dependency cycle:"));
}

#[test]
fn scans_macro_token_paths_without_reading_comments_or_literals_as_code() {
    let f = Fixture::new();
    f.write("lib.rs", "mod models; mod btcc;");
    f.write("models.rs", "pub struct Model;");
    f.write(
        "btcc.rs",
        r#"// use crate::models::Model;
const TEXT: &str = "crate::models::Model";
fn run() { inspect!("crate::models::Model"); }
"#,
    );
    f.check(true);
    f.write(
        "btcc.rs",
        "fn run() { inspect!({ crate::models::Model }); }",
    );
    assert!(
        f.check(false)
            .contains("dependency btcc -> models is not allowed")
    );
}

#[test]
fn follows_explicit_module_files_and_rejects_fragments_and_missing_source() {
    let f = Fixture::new();
    f.write("lib.rs", "#[path=\"domain.rs\"] mod models; mod btcc;");
    f.write("domain.rs", "use crate::btcc::Thing;");
    f.write("btcc.rs", "pub struct Thing;");
    f.check(true);
    f.write("domain.rs", "#[path=\"implementation.rs\"] mod inner;");
    f.write("implementation.rs", "use crate::btcc::Thing;");
    f.check(true);
    f.write(
        "domain.rs",
        "mod inline { #[path=\"implementation.rs\"] mod inner; }",
    );
    f.write("domain/inline/implementation.rs", "use crate::btcc::Thing;");
    f.check(true);
    f.write("domain.rs", "include!(\"hidden.rs\");");
    assert!(f.check(false).contains("include! source fragments"));
    f.write("domain.rs", "mod missing;");
    assert!(
        f.check(false)
            .contains("missing source module models::missing")
    );
    f.write("domain.rs", "fn malformed(");
    assert!(f.check(false).contains("invalid Rust syntax"));
}

#[test]
fn rejects_hidden_root_or_block_modules_and_recursive_file_inclusion() {
    let f = Fixture::new();
    f.write("lib.rs", "include!(\"domains.rs\");");
    assert!(f.check(false).contains("include! source fragments"));
    f.write("lib.rs", "mod models;");
    f.write(
        "models.rs",
        "fn run() { mod nested { use crate::models; } }",
    );
    assert!(f.check(false).contains("block-local modules"));
    f.write("models.rs", "#[path=\"models.rs\"] mod recursive;");
    assert!(f.check(false).contains("recursive source module"));
}
