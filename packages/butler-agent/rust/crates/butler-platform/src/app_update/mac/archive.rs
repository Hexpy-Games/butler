//! ZIP admission and bounded extraction. Links are materialized after all writes.
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

const ENTRY_LIMIT: u64 = 1024 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 4 * ENTRY_LIMIT;
const LINK_LIMIT: u64 = 4096;
struct Entry {
    path: PathBuf,
    mode: u32,
    link: Option<PathBuf>,
}

pub(crate) fn extract(artifact: &Path, staging: &Path) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    crate::secure_fs::no_follow(&mut options);
    let mut archive = ZipArchive::new(options.open(artifact).map_err(error)?).map_err(error)?;
    let entries = validate(&mut archive)?;
    // Canonicalize all validated entries before invoking ditto. It preserves
    // AppleDouble signatures/resource forks, but never sees attacker-controlled
    // local headers, path overrides, hard-link metadata or unlisted entries.
    let canonical = staging.join("validated.zip");
    let mut output = fs::OpenOptions::new();
    output.write(true).create_new(true);
    crate::secure_fs::owner_only(&mut output);
    let mut writer = ZipWriter::new(output.open(&canonical).map_err(error)?);
    for (index, entry) in entries.iter().enumerate() {
        let name = entry.path.to_str().ok_or("Invalid ZIP path")?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(entry.mode & 0o777);
        if entry.link.is_some() {
            continue;
        }
        if entry.mode & 0o170_000 == 0o040_000 {
            writer.add_directory(name, options).map_err(error)?;
        } else {
            writer.start_file(name, options).map_err(error)?;
            let mut source = archive.by_index(index).map_err(error)?;
            let count = std::io::copy(&mut source.by_ref().take(ENTRY_LIMIT + 1), &mut writer)
                .map_err(error)?;
            if count != source.size() || count > ENTRY_LIMIT {
                return Err("Invalid ZIP entry size".into());
            }
        }
    }
    writer.finish().map_err(error)?.sync_all().map_err(error)?;
    super::super::run(
        std::process::Command::new("ditto")
            .args(["-x", "-k"])
            .arg(&canonical)
            .arg(staging),
    )?;
    fs::remove_file(canonical).map_err(error)?;
    materialize_links(staging, &entries)
}

// Ditto receives no links. After every data write, resolve on the actual
// filesystem too: macOS case/Unicode aliases must not bypass the link graph.
fn materialize_links(staging: &Path, entries: &[Entry]) -> Result<(), String> {
    let root = fs::canonicalize(staging).map_err(error)?;
    for entry in entries {
        if let Some(target) = &entry.link {
            let path = root.join(&entry.path);
            let parent =
                fs::canonicalize(path.parent().ok_or("Invalid ZIP link")?).map_err(error)?;
            if !parent.starts_with(&root) {
                return Err("ZIP link parent escapes staging".into());
            }
            std::os::unix::fs::symlink(target, path).map_err(error)?;
        }
    }
    for entry in entries.iter().filter(|entry| entry.link.is_some()) {
        let path = fs::canonicalize(root.join(&entry.path))
            .map_err(|_| "ZIP link destination is unavailable".to_owned())?;
        let bundle = entry.path.components().next().ok_or("Invalid ZIP link")?;
        if !path.starts_with(root.join(bundle.as_os_str())) {
            return Err("ZIP link escapes its bundle".into());
        }
    }
    Ok(())
}

fn validate(archive: &mut ZipArchive<fs::File>) -> Result<Vec<Entry>, String> {
    if archive.len() > 100_000 {
        return Err("Too many ZIP entries".into());
    }
    let mut entries = Vec::new();
    let mut paths = BTreeMap::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(error)?;
        let path = entry_path(file.name())?;
        let mode = file
            .unix_mode()
            .unwrap_or(if file.is_dir() { 0o040_755 } else { 0o100_644 });
        let kind = mode & 0o170_000;
        if !matches!(kind, 0 | 0o100_000 | 0o040_000 | 0o120_000) {
            return Err("Special ZIP entry refused".into());
        }
        reject_link_extra(file.extra_data().unwrap_or_default())?;
        total = total.checked_add(file.size()).ok_or("ZIP is too large")?;
        if file.size() > ENTRY_LIMIT || total > TOTAL_LIMIT {
            return Err("ZIP is too large".into());
        }
        let link = if kind == 0o120_000 {
            if file.size() > LINK_LIMIT {
                return Err("ZIP link is too large".into());
            }
            let mut target = String::new();
            file.by_ref()
                .take(LINK_LIMIT + 1)
                .read_to_string(&mut target)
                .map_err(error)?;
            if target.contains(['\\', '\0']) {
                return Err("Invalid ZIP link".into());
            }
            Some(PathBuf::from(target))
        } else {
            None
        };
        if paths.insert(path.clone(), link.clone()).is_some() {
            return Err("Duplicate ZIP entry".into());
        }
        entries.push(Entry {
            path,
            mode: if kind == 0 { mode | 0o100_000 } else { mode },
            link,
        });
    }
    for entry in &entries {
        if entry
            .path
            .ancestors()
            .skip(1)
            .any(|p| paths.get(p).is_some_and(Option::is_some))
        {
            return Err("ZIP writes through a link".into());
        }
        if let Some(link) = &entry.link {
            resolve_link(&entry.path, link, &paths)?;
        }
    }
    Ok(entries)
}

fn entry_path(name: &str) -> Result<PathBuf, String> {
    if name.contains(['\\', '\0', ':'])
        || name.starts_with('/')
        || name.split('/').any(|part| part == "..")
    {
        return Err("Unsafe ZIP path".into());
    }
    let path = PathBuf::from(name);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || !path.starts_with("Butler.app") && !path.starts_with("__MACOSX")
    {
        return Err("Unsafe ZIP path".into());
    }
    Ok(path)
}

fn resolve_link(
    path: &Path,
    link: &Path,
    paths: &BTreeMap<PathBuf, Option<PathBuf>>,
) -> Result<(), String> {
    let mut pending = path.parent().ok_or("Invalid ZIP link")?.join(link);
    for _ in 0..=paths.len() {
        let mut resolved = PathBuf::new();
        let mut replaced = false;
        let current = pending.clone();
        let parts: Vec<_> = current.components().collect();
        for (index, part) in parts.iter().enumerate() {
            match part {
                Component::Normal(p) => resolved.push(p),
                Component::CurDir => {}
                Component::ParentDir if resolved.pop() => {}
                _ => return Err("ZIP link escapes staging".into()),
            }
            if let Some(Some(target)) = paths.get(&resolved) {
                pending = resolved.parent().ok_or("Invalid ZIP link")?.join(target);
                for remaining in parts.get(index + 1..).ok_or("Invalid ZIP link")? {
                    pending.push(remaining.as_os_str());
                }
                replaced = true;
                break;
            }
        }
        if !replaced {
            if resolved.components().next() != path.components().next() {
                return Err("ZIP link escapes its bundle".into());
            }
            return Ok(());
        }
    }
    Err("Cyclic ZIP link".into())
}

// PKWARE Unix and ASi Unix can encode hard links/device nodes. Refuse these
// extensions rather than delegate their interpretation to a native extractor.
fn reject_link_extra(mut data: &[u8]) -> Result<(), String> {
    while let Some([a, b, c, d]) = data.get(..4) {
        let id = u16::from_le_bytes([*a, *b]);
        let size = usize::from(u16::from_le_bytes([*c, *d]));
        if (id == 0x000d && size > 12) || id == 0x756e {
            return Err("ZIP hard link metadata refused".into());
        }
        data = data.get(4 + size..).ok_or("Invalid ZIP extra field")?;
    }
    if !data.is_empty() {
        return Err("Invalid ZIP extra field".into());
    }
    Ok(())
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
