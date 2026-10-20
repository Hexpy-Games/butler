use super::store::{OutputKind, PublishRequest, error};
use butler_platform::secure_fs;
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path},
};

pub(super) fn relative(path: &str) -> std::io::Result<()> {
    if path.is_empty()
        || path.contains(['\\', '\0'])
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(error("unsafe_output_path"));
    }
    Ok(())
}
fn checked(root: &Path, path: &Path) -> std::io::Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| error("unsafe_output_path"))?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(error("unsafe_output_path"));
        }
        current.push(part);
        if std::fs::symlink_metadata(&current)?
            .file_type()
            .is_symlink()
        {
            return Err(error("output_symlink_refused"));
        }
    }
    if !std::fs::canonicalize(path)?.starts_with(root) {
        return Err(error("unsafe_output_path"));
    }
    Ok(())
}
pub(super) struct Snapshot {
    pub files: BTreeMap<String, Vec<u8>>,
    pub entry: String,
    pub size: u64,
    pub source: String,
    pub kind: OutputKind,
}
pub(super) fn collect(request: &PublishRequest) -> std::io::Result<Snapshot> {
    let root = std::fs::canonicalize(&request.workspace)?;
    let requested = Path::new(&request.path);
    let rel = if requested.is_absolute() {
        requested
            .strip_prefix(&root)
            .map_err(|_| error("unsafe_output_path"))?
    } else {
        requested
    };
    relative(rel.to_str().ok_or_else(|| error("unsafe_output_path"))?)?;
    let source = root.join(rel);
    checked(&root, &source)?;
    let metadata = std::fs::symlink_metadata(&source)?;
    let base = if metadata.is_file() {
        source.parent().ok_or_else(|| error("unsafe_output_path"))?
    } else {
        &source
    };
    let mut files = BTreeMap::new();
    let mut size = 0;
    visit(&root, base, &source, &mut files, &mut size)?;
    let entry = request.entry.clone().unwrap_or_else(|| {
        if metadata.is_file() {
            source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            "index.html".into()
        }
    });
    relative(&entry)?;
    if !files.contains_key(&entry) {
        return Err(error("output_entry_not_found"));
    }
    Ok(Snapshot {
        files,
        entry,
        size,
        source: rel.to_string_lossy().into_owned(),
        kind: if metadata.is_file() {
            OutputKind::File
        } else {
            OutputKind::Site
        },
    })
}
fn visit(
    root: &Path,
    base: &Path,
    path: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    size: &mut u64,
) -> std::io::Result<()> {
    checked(root, path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        for child in std::fs::read_dir(path)? {
            visit(root, base, &child?.path(), files, size)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(error("output_regular_files_only"));
    }
    if files.len() >= 2000 || *size + metadata.len() > 100_000_000 {
        return Err(error("output_limit_exceeded"));
    }
    let relative_file = path
        .strip_prefix(root)
        .map_err(|_| error("unsafe_output_path"))?;
    let mut file = secure_fs::open_read_beneath(root, relative_file)?;
    if !file.metadata()?.is_file() {
        return Err(error("output_regular_files_only"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(100_000_001 - *size)
        .read_to_end(&mut bytes)?;
    checked(root, path)?;
    *size += bytes.len() as u64;
    if *size > 100_000_000 {
        return Err(error("output_limit_exceeded"));
    }
    let name = path
        .strip_prefix(base)
        .map_err(|_| error("unsafe_output_path"))?
        .to_str()
        .ok_or_else(|| error("unsafe_output_path"))?
        .replace('\\', "/");
    relative(&name)?;
    files.insert(name, bytes);
    Ok(())
}
