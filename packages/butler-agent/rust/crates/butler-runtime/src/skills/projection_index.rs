//! Keep the loaded-skill fact while parsing only appended transcript bytes.
use butler_platform::secure_fs::{FileIdentity, identity};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct Index(HashMap<PathBuf, Arc<Mutex<Option<Entry>>>>);
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
    // The directory lock selects a slot only. Unrelated transcripts may read
    // concurrently; same-file reads still share one identity and append cursor.
    let slot = index
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .0
        .entry(path.clone())
        .or_default()
        .clone();
    let mut entry = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let metadata = file.metadata().ok()?;
    let current = identity(&metadata);
    let size = metadata.len();
    let prior = entry.as_ref();
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
    // The reverse scan already encounters the latest complete line boundary.
    // Reuse its descriptor and boundary rather than reopening and reading the
    // transcript a second time. Partial trailing records are still revisited.
    let (names, offset) = super::projection::latest_names_since(&mut file, size, turn, cutoff)?;
    let names = names.or_else(|| {
        prior
            .filter(|_| reusable)
            .and_then(|entry| entry.names.clone())
    });
    // A partial last record must be revisited on append, including a complete
    // JSON value that has not yet acquired its newline.
    let saved_anchor = anchor(&mut file, offset)?;
    *entry = Some(Entry {
        turn: turn.map(str::to_owned),
        size,
        offset,
        identity: current,
        anchor: saved_anchor,
        names: names.clone(),
    });
    names
}

fn anchor(file: &mut File, end: u64) -> Option<Vec<u8>> {
    let start = end.saturating_sub(256);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = vec![0; usize::try_from(end - start).ok()?];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}
