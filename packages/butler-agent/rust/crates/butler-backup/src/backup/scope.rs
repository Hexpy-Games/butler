use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

const INCLUDE: &[&str] = &[
    "butler.config.json",
    "gateways/app.json",
    "hooks.json",
    "eol.md",
    "config/session-id.txt",
    "personas/",
    "personalization/",
    "app-server/butler-client.sqlite",
    "agent-runtime/btcc.sqlite",
    "runtime/conversation-store.sqlite",
    "runtime/session-store.sqlite",
    "transcripts/",
    "app-server/message-files/",
    "app-server/assets/",
    "outputs/",
    "artifacts/generated/",
    "cognition/profile/",
    "cognition/know-how/",
    "cognition/memory/rules/",
    "cognition/memory/active-generation.json",
    "cognition/memory/hot/",
    "skills/",
    "wallpapers/",
    "work-streams/",
    "auth/vault.age",
    "auth/vault-migration.json",
    "auth/model-provider-credentials.json",
];
const GENERATIONS: &str = "cognition/memory/generations/";
const SKIP_SUFFIX: &[&str] = &[".lock"];

pub fn allowed(rel: &str) -> bool {
    if rel.contains(['\\', ':'])
        || rel.split('/').any(|part| {
            matches!(part, "" | "." | "..")
                || part.contains(".tmp-")
                || SKIP_SUFFIX.iter().any(|suffix| part.ends_with(suffix))
        })
    {
        return false;
    }
    INCLUDE.iter().any(|entry| {
        if entry.ends_with('/') {
            rel.starts_with(entry)
        } else {
            rel == *entry
        }
    }) || rel
        .strip_prefix(GENERATIONS)
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(_, path)| path != "butler.lance" && !path.starts_with("butler.lance/"))
}

pub fn active_generation(root: &Path) -> io::Result<Option<String>> {
    #[derive(serde::Deserialize)]
    struct Descriptor {
        generation_id: String,
    }
    let path = Path::new("cognition/memory/active-generation.json");
    let file = butler_platform::secure_fs::open_read_beneath(root, path);
    let file = match file {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let descriptor: Descriptor = serde_json::from_reader(file)?;
    if descriptor.generation_id.contains('/')
        || !allowed(&format!(
            "{GENERATIONS}{}/graph.sqlite",
            descriptor.generation_id
        ))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid memory generation",
        ));
    }
    Ok(Some(descriptor.generation_id))
}

pub fn walk(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in INCLUDE {
        visit(
            root,
            entry.trim_end_matches('/'),
            entry.ends_with('/'),
            &mut files,
        )?;
    }
    if let Some(id) = active_generation(root)? {
        visit(root, &format!("{GENERATIONS}{id}"), true, &mut files)?;
    }
    files.sort();
    Ok(files)
}

fn visit(root: &Path, rel: &str, directory: bool, files: &mut Vec<PathBuf>) -> io::Result<()> {
    let path = root.join(rel);
    let mut ancestor = root.to_path_buf();
    let mut metadata = None;
    for part in rel.split('/') {
        ancestor.push(part);
        match fs::symlink_metadata(&ancestor) {
            Ok(next) if !next.is_symlink() => metadata = Some(next),
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
    }
    let Some(metadata) = metadata else {
        return Ok(());
    };
    if directory && metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let child = format!("{rel}/{name}");
            if allowed(&child) {
                visit(root, &child, entry.file_type()?.is_dir(), files)?;
            }
        }
    } else if metadata.is_file() && allowed(rel) && !sqlite_sidecar(&path)? {
        files.push(PathBuf::from(rel));
    }
    Ok(())
}

fn sqlite_sidecar(path: &Path) -> io::Result<bool> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    for suffix in ["-wal", "-shm", "-journal"] {
        if let Some(base) = name.strip_suffix(suffix) {
            let base = path.with_file_name(base);
            if fs::symlink_metadata(&base).is_ok_and(|meta| meta.is_file()) {
                return is_sqlite(&base);
            }
        }
    }
    Ok(false)
}

pub fn is_sqlite(path: &Path) -> io::Result<bool> {
    let mut magic = [0; 16];
    match butler_platform::secure_fs::open_read_no_follow(path)?.read_exact(&mut magic) {
        Ok(()) => Ok(&magic == b"SQLite format 3\0"),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error),
    }
}
