//! Golden snapshots: normalized text compared byte for byte with a checked-in
//! file. `BUTLER_UPDATE_GOLDEN=1` rewrites the file; only do that for an
//! intended format change and review the diff.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::Value;

/// Replaces run-dependent text (paths, clocks, random ids, digests over them)
/// with stable placeholders. Ids and digests are numbered by first
/// appearance, so equal values stay visibly equal.
pub(crate) struct Normalizer {
    data_root: String,
    timestamp: Regex,
    epoch_ms: Regex,
    inode: Regex,
    lock_shard: Regex,
    uuid: Regex,
    digest: Regex,
    numbered: HashMap<String, String>,
}

impl Normalizer {
    pub(crate) fn new(data_root: &Path) -> Self {
        Self {
            data_root: data_root.to_string_lossy().into_owned(),
            timestamp: Regex::new(
                r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?",
            )
            .unwrap(),
            epoch_ms: Regex::new(r"\b1[0-9]{12}(\.[0-9]+)?\b").unwrap(),
            inode: Regex::new(r#""\d+:"#).unwrap(),
            lock_shard: Regex::new(r"mutation-lock-\d{2}").unwrap(),
            uuid: Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
                .unwrap(),
            digest: Regex::new(r"\b[0-9a-f]{64}\b").unwrap(),
            numbered: HashMap::new(),
        }
    }

    pub(crate) fn text(&mut self, text: &str) -> String {
        let text = text.replace(&self.data_root, "$DATA");
        let text = self.timestamp.replace_all(&text, "<ts>").into_owned();
        let text = self.epoch_ms.replace_all(&text, "<epoch-ms>").into_owned();
        let text = self.inode.replace_all(&text, "\"<inode>:").into_owned();
        let text = self.number(&text, Kind::Uuid);
        self.number(&text, Kind::Digest)
    }

    /// Like `text`, but ids and digests not seen yet become a bare
    /// placeholder instead of taking the next number.
    pub(crate) fn blank(&self, text: &str) -> String {
        let text = text.replace(&self.data_root, "$DATA");
        let text = self.timestamp.replace_all(&text, "<ts>");
        let text = self.epoch_ms.replace_all(&text, "<epoch-ms>");
        let text = self.inode.replace_all(&text, "\"<inode>:");
        let known = |pattern: &Regex, text: &str, bare: &str| {
            pattern
                .replace_all(text, |found: &regex::Captures<'_>| {
                    self.numbered
                        .get(&found[0])
                        .cloned()
                        .unwrap_or_else(|| bare.to_owned())
                })
                .into_owned()
        };
        let text = known(&self.uuid, &text, "<uuid>");
        let text = known(&self.digest, &text, "<sha>");
        self.shard(&text)
    }

    /// Lock shard numbers hash the (random) data root.
    pub(crate) fn shard(&self, text: &str) -> String {
        self.lock_shard
            .replace_all(text, "mutation-lock-NN")
            .into_owned()
    }

    pub(crate) fn json(&mut self, value: &Value) -> String {
        let pretty = serde_json::to_string_pretty(value).unwrap();
        self.text(&pretty)
    }

    fn number(&mut self, text: &str, kind: Kind) -> String {
        let (pattern, label) = match kind {
            Kind::Uuid => (&self.uuid, "uuid"),
            Kind::Digest => (&self.digest, "sha"),
        };
        let found: Vec<String> = pattern
            .find_iter(text)
            .map(|found| found.as_str().to_owned())
            .collect();
        let mut text = text.to_owned();
        for value in found {
            let next = self.numbered.len() + 1;
            let placeholder = self
                .numbered
                .entry(value.clone())
                .or_insert_with(|| format!("<{label}:{next}>"))
                .clone();
            text = text.replace(&value, &placeholder);
        }
        text
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Uuid,
    Digest,
}

/// Every file under `root` as normalized text sections. Files are ordered by
/// their path and content with every run-dependent value blanked, so names
/// derived from random paths still sort the same way on every run.
pub(crate) fn tree(root: &Path, normalizer: &mut Normalizer) -> String {
    let mut paths = Vec::new();
    collect(root, &mut paths);
    let (shards, paths): (Vec<_>, Vec<_>) = paths.into_iter().partition(|path| {
        path.extension()
            .is_some_and(|extension| extension == "sqlite3")
    });
    let mut files: Vec<(String, String, String)> = paths
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let content = read(&path, &relative);
            let key = normalizer.blank(&format!("{relative}\n{content}"));
            (key, relative, content)
        })
        .collect();
    if !shards.is_empty() {
        files.push((
            String::new(),
            "runtime/mutation-lock-shards/*.sqlite3".to_owned(),
            lock_shards(&shards),
        ));
    }
    files.sort();
    let mut out = String::new();
    for (_, relative, content) in files {
        let relative = normalizer.text(&normalizer.shard(&relative));
        let content = normalizer.text(&content);
        let _ = write!(out, "--- file {relative}\n{content}");
        if !out.ends_with('\n') {
            out.push_str("\n<no trailing newline>\n");
        }
    }
    out
}

fn read(path: &Path, relative: &str) -> String {
    if relative.ends_with("-wal") || relative.ends_with("-shm") {
        return "<sqlite sidecar>\n".to_owned();
    }
    String::from_utf8(fs::read(path).unwrap()).unwrap_or_else(|_| "<binary>\n".to_owned())
}

/// Which shard a lock lands in hashes the (random) data root, so the shards
/// are pinned together: one schema, the total fence generation and the
/// number of locks still held.
fn lock_shards(shards: &[PathBuf]) -> String {
    let mut schemas: Vec<String> = shards.iter().map(|path| schema(path).0).collect();
    schemas.dedup();
    assert_eq!(schemas.len(), 1, "lock shards disagree on their schema");
    let (mut generations, mut held) = (0_i64, 0_i64);
    for path in shards {
        let connection = rusqlite::Connection::open(path).unwrap();
        generations += connection
            .query_row(
                "SELECT generation FROM shard_fence WHERE singleton=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        held += connection
            .query_row("SELECT count(*) FROM active_lock", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
    }
    format!(
        "{}fence generations: {generations}\nheld locks: {held}\n",
        schemas.concat()
    )
}

/// A SQLite file's schema (and table names), in a stable order.
fn schema(path: &Path) -> (String, Vec<String>) {
    let connection = rusqlite::Connection::open(path).unwrap();
    let mut out = String::new();
    let mut tables = Vec::new();
    let mut schema = connection
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
    let rows = schema
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .unwrap();
    for row in rows {
        let (kind, name, sql) = row.unwrap();
        let _ = writeln!(out, "{kind} {name}: {}", sql.unwrap_or_default());
        if kind == "table" {
            tables.push(name);
        }
    }
    (out, tables)
}

fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect(&path, files);
        } else {
            files.push(path);
        }
    }
}

/// Compares `actual` with `tests/golden/<name>`, or rewrites it when
/// `BUTLER_UPDATE_GOLDEN=1`.
pub(crate) fn assert_golden(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    if std::env::var_os("BUTLER_UPDATE_GOLDEN").is_some_and(|value| value == "1") {
        fs::write(&path, actual).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing golden {}: {error}", path.display()));
    if expected != actual {
        let actual_path = path.with_extension("actual");
        fs::write(&actual_path, actual).unwrap();
        let line = expected
            .lines()
            .zip(actual.lines())
            .position(|(left, right)| left != right)
            .unwrap_or_else(|| expected.lines().count().min(actual.lines().count()));
        panic!(
            "{name} differs from the golden at line {}; actual written to {}",
            line + 1,
            actual_path.display()
        );
    }
}
