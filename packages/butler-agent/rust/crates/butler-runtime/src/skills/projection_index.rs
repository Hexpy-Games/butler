//! Keep the loaded-skill fact while parsing only appended transcript bytes.
use butler_platform::secure_fs::{FileIdentity, identity};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Default)]
pub(super) struct Index(HashMap<PathBuf, Entry>);
struct Entry {
    turn: Option<String>,
    size: u64,
    offset: u64,
    identity: FileIdentity,
    anchor: Vec<u8>,
    names: Option<Vec<String>>,
}

pub(super) fn read(
    index: &Mutex<Index>,
    root: &Path,
    session: &str,
    turn: Option<&str>,
) -> Option<Vec<String>> {
    let safe: String = session
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => {
                char::from(byte)
            }
            _ => '_',
        })
        .collect();
    let path = root.join("transcripts").join(format!("{safe}.jsonl"));
    let mut file = File::open(&path).ok()?;
    let metadata = file.metadata().ok()?;
    let current = identity(&metadata);
    let size = metadata.len();
    let mut index = index
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let prior = index.0.get(&path);
    let reusable = prior.is_some_and(|entry| {
        entry.turn.as_deref() == turn
            && current.id == entry.identity.id
            && size >= entry.size
            && (size > entry.size || current == entry.identity)
            && anchor(&mut file, entry.offset).as_ref() == Some(&entry.anchor)
    });
    if reusable
        && let Some(entry) = prior
        && size == entry.size
        && current == entry.identity
    {
        return entry.names.clone();
    }
    let cutoff = prior.filter(|_| reusable).map_or(0, |entry| entry.offset);
    let names = super::projection::latest_names_since(&path, turn, cutoff).or_else(|| {
        prior
            .filter(|_| reusable)
            .and_then(|entry| entry.names.clone())
    });
    // A partial last record must be revisited on append, including a complete
    // JSON value that has not yet acquired its newline.
    let offset = last_boundary(&mut file, size)?;
    let saved_anchor = anchor(&mut file, offset)?;
    index.0.insert(
        path,
        Entry {
            turn: turn.map(str::to_owned),
            size,
            offset,
            identity: current,
            anchor: saved_anchor,
            names: names.clone(),
        },
    );
    names
}

fn anchor(file: &mut File, end: u64) -> Option<Vec<u8>> {
    let start = end.saturating_sub(256);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = vec![0; usize::try_from(end - start).ok()?];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}
fn last_boundary(file: &mut File, size: u64) -> Option<u64> {
    let mut end = size;
    let mut bytes = vec![0; 32 * 1024];
    while end > 0 {
        let start = end.saturating_sub(bytes.len() as u64);
        let count = usize::try_from(end - start).ok()?;
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut bytes[..count]).ok()?;
        if let Some(index) = bytes[..count].iter().rposition(|byte| *byte == b'\n') {
            return Some(start + index as u64 + 1);
        }
        end = start;
    }
    Some(0)
}
