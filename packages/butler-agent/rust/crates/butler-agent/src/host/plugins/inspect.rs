use super::{Result, error, types::*};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub files: usize,
    pub bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            files: 50_000,
            bytes: 1 << 30,
        }
    }
}

pub(crate) fn relative(value: &str) -> Result<&Path> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains(['\\', '\0', ':'])
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(error("invalid_plugin_path"));
    }
    Ok(path)
}

pub(crate) fn hash_file(mut file: fs::File) -> Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|_| error("plugin_file_unreadable"))?;
        if size == 0 {
            break;
        }
        hash.update(
            buffer
                .get(..size)
                .ok_or_else(|| error("plugin_file_unreadable"))?,
        );
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn snapshot(source: &Path, dest: &Path, limits: Limits) -> Result<Vec<FileRecord>> {
    collect(source, Some(dest), limits)
}
pub(crate) fn inventory(source: &Path, limits: Limits) -> Result<Vec<FileRecord>> {
    collect(source, None, limits)
}
fn collect(source: &Path, dest: Option<&Path>, limits: Limits) -> Result<Vec<FileRecord>> {
    let metadata = fs::symlink_metadata(source).map_err(|_| error("plugin_path_unreadable"))?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(error("plugin_symlink_refused"));
    }
    let mut tree = Tree {
        source,
        dest,
        limits,
        files: Vec::new(),
        pending: Vec::new(),
        directories: Vec::new(),
        names: BTreeSet::new(),
        bytes: 0,
    };
    // Validate every path and the total metadata budget before creating staging
    // or opening file contents. Oversized packages must never be copied first.
    tree.walk(Path::new(""))?;
    if let Some(dest) = dest {
        for dir in &tree.directories {
            butler_platform::secure_fs::create_private_dir_all(&dest.join(dir))
                .map_err(|_| error("plugin_copy_failed"))?;
        }
    }
    for (rel, path, meta) in std::mem::take(&mut tree.pending) {
        tree.copy_file(&rel, path, &meta)?;
    }
    tree.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(tree.files)
}
struct Tree<'a> {
    source: &'a Path,
    dest: Option<&'a Path>,
    limits: Limits,
    files: Vec<FileRecord>,
    pending: Vec<(PathBuf, String, fs::Metadata)>,
    directories: Vec<PathBuf>,
    names: BTreeSet<String>,
    bytes: u64,
}
impl Tree<'_> {
    fn walk(&mut self, dir: &Path) -> Result<()> {
        self.directories.push(dir.to_owned());
        for entry in
            fs::read_dir(self.source.join(dir)).map_err(|_| error("plugin_path_unreadable"))?
        {
            let entry = entry.map_err(|_| error("plugin_path_unreadable"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| error("invalid_plugin_path"))?;

            relative(&name)?;
            let rel = dir.join(name);
            let portable = rel
                .iter()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            insert_path(&mut self.names, &portable)?;
            let meta =
                fs::symlink_metadata(entry.path()).map_err(|_| error("plugin_path_unreadable"))?;
            if name_is_git_dir(&rel, &meta) {
                continue;
            }
            if meta.is_symlink() {
                return Err(error("plugin_symlink_refused"));
            }
            if meta.is_dir() {
                self.walk(&rel)?;
            } else if meta.is_file() {
                self.plan_file(rel, portable, meta)?;
            } else {
                return Err(error("plugin_special_file_refused"));
            }
        }
        Ok(())
    }
    fn plan_file(&mut self, rel: PathBuf, path: String, meta: fs::Metadata) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(meta.len())
            .ok_or_else(|| error("plugin_too_large"))?;
        if self.pending.len() >= self.limits.files || self.bytes > self.limits.bytes {
            return Err(error("plugin_too_large"));
        }
        self.pending.push((rel, path, meta));
        Ok(())
    }
    fn copy_file(&mut self, rel: &Path, path: String, meta: &fs::Metadata) -> Result<()> {
        let target = self.dest.unwrap_or(self.source).join(rel);
        if self.dest.is_some() {
            self.copy_contents(rel, &target, meta)?;
        }
        let copied = fs::symlink_metadata(&target).map_err(|_| error("plugin_copy_failed"))?;
        if copied.len() != meta.len() {
            return Err(error("plugin_changed_during_inspect"));
        }
        self.files.push(FileRecord {
            path,
            mode: butler_platform::plugin_files::mode(meta),
            size: copied.len(),
            modified: copied.modified().map_err(|_| error("plugin_copy_failed"))?,
            hash: hash_file(
                butler_platform::secure_fs::open_package_file(
                    self.dest.unwrap_or(self.source),
                    rel,
                )
                .map_err(|_| error("plugin_symlink_refused"))?,
            )?,
        });
        Ok(())
    }
    fn copy_contents(&self, rel: &Path, target: &Path, meta: &fs::Metadata) -> Result<()> {
        let file = butler_platform::secure_fs::open_package_file(self.source, rel)
            .map_err(|_| error("plugin_symlink_refused"))?;
        let mut out = fs::File::create(target).map_err(|_| error("plugin_copy_failed"))?;
        std::io::copy(&mut file.take(meta.len() + 1), &mut out)
            .map_err(|_| error("plugin_copy_failed"))?;
        if let Some(mode) = butler_platform::secure_fs::file_mode(meta)
            && let Some(result) = butler_platform::secure_fs::set_file_mode(target, mode)
        {
            result.map_err(|_| error("plugin_copy_failed"))?;
        }
        Ok(())
    }
}

pub(crate) fn digest(files: &[FileRecord]) -> String {
    let mut lines = files
        .iter()
        .map(|f| format!("{}\0{}\0{}\n", f.path, f.mode, f.hash))
        .collect::<Vec<_>>();
    lines.sort();
    let mut hash = Sha256::new();
    for line in lines {
        hash.update(line.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

pub(crate) fn insert_path(names: &mut BTreeSet<String>, path: &str) -> Result<()> {
    if !names.insert(path.to_lowercase()) {
        return Err(error("plugin_case_collision"));
    }
    Ok(())
}

fn name_is_git_dir(path: &Path, meta: &fs::Metadata) -> bool {
    path.file_name().is_some_and(|s| s == ".git") && meta.is_dir() && !meta.is_symlink()
}
