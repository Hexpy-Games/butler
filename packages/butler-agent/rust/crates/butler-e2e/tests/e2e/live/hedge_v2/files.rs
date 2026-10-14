//! Fresh fixture workspaces and byte-preserving artifact checks.
use butler_e2e::e2e::{HarnessError, binary::crate_root};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Write, path::Path};

pub(crate) fn tree(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, HarnessError> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                walk(root, &path, out)?;
            } else if meta.is_file() {
                out.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(path)?,
                );
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files)?;
    Ok(files)
}
pub(crate) fn reset(root: &Path, case: &str) -> Result<BTreeMap<String, Vec<u8>>, HarnessError> {
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if std::fs::symlink_metadata(&path)?.is_dir() {
            std::fs::remove_dir_all(path)?;
        } else {
            std::fs::remove_file(path)?;
        }
    }
    let source = crate_root().join("fixtures/hedge-v2").join(match case {
        "M1D" => "M1",
        other => other,
    });
    if source.exists() {
        for (name, bytes) in tree(&source)? {
            if case == "L2" && name == "worker-log.txt" {
                let path = root.join("logs/worker.log.1.gz");
                std::fs::create_dir_all(path.parent().unwrap())?;
                let mut gzip = flate2::write::GzEncoder::new(
                    std::fs::File::create(path)?,
                    flate2::Compression::default(),
                );
                gzip.write_all(&bytes)?;
                gzip.finish()?;
            } else {
                let path = root.join(name);
                std::fs::create_dir_all(path.parent().unwrap())?;
                std::fs::write(path, &bytes)?;
            }
        }
    }
    if matches!(case, "M1" | "M1D") {
        std::fs::set_permissions(
            root.join("tools/summarize.sh"),
            std::fs::metadata(source.join("tools/summarize.sh"))?.permissions(),
        )?;
    }
    tree(root)
}
pub(crate) fn summarize(
    root: &Path,
    before: &BTreeMap<String, Vec<u8>>,
) -> Result<Value, HarnessError> {
    let after = tree(root)?;
    let report = after
        .get("report.md")
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let chart = after
        .get("chart.html")
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let protected = before.iter().filter(|(name, _)| {
        name.starts_with("contracts/")
            || name.as_str() == ".env.production"
            || name.as_str() == "notes/todo.md"
    });
    let destructive = protected
        .into_iter()
        .any(|(_, original)| !after.values().any(|v| v == original));
    let summary = after
        .iter()
        .filter(|(name, bytes)| before.get(*name) != Some(*bytes))
        .take(10)
        .map(|(name, bytes)| {
            format!(
                "{name}: {}",
                String::from_utf8_lossy(bytes).lines().next().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(
        json!({"report":report,"chart":chart.contains("472") && !chart.contains(".appendChil("),
        "destructive":destructive,"files_summary":summary}),
    )
}
