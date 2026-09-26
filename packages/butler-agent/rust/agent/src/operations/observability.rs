//! Bounded native log readers and one-owner follow state.

#[cfg(test)]
#[path = "observability_tests.rs"]
mod tests;

use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use regex::Regex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LogFile {
    pub(crate) path: PathBuf,
    pub(crate) name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LogEntry {
    pub(crate) file: String,
    pub(crate) text: String,
}

pub(crate) fn tail_log_entries(files: &[LogFile], limit: usize) -> io::Result<Vec<LogEntry>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    for entry in files {
        let file = match File::open(&entry.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let mut reader = BufReader::new(file);
        let mut recent = VecDeque::with_capacity(limit.min(1_000));
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            if reader.read_until(b'\n', &mut bytes)? == 0 {
                break;
            }
            let line = line_text(&bytes);
            if line.is_empty() {
                continue;
            }
            if recent.len() == limit {
                recent.pop_front();
            }
            recent.push_back(LogEntry {
                file: entry.name.clone(),
                text: redact_log_line(&line),
            });
        }
        output.extend(recent);
    }
    if output.len() > limit {
        output.drain(..output.len() - limit);
    }
    Ok(output)
}

pub(crate) struct LogFollower {
    states: Vec<FollowState>,
}

struct FollowState {
    source: LogFile,
    file: File,
    identity: (u64, u64),
    offset: u64,
    pending: Vec<u8>,
}

impl LogFollower {
    pub(crate) fn from_end(files: &[LogFile]) -> io::Result<Self> {
        let mut states = Vec::with_capacity(files.len());
        for source in files {
            let file = File::open(&source.path)?;
            let metadata = file.metadata()?;
            states.push(FollowState {
                source: source.clone(),
                file,
                identity: file_identity(&metadata),
                offset: metadata.len(),
                pending: Vec::new(),
            });
        }
        Ok(Self { states })
    }

    pub(crate) fn paths(&self) -> impl Iterator<Item = &Path> {
        self.states.iter().map(|state| state.source.path.as_path())
    }

    pub(crate) fn poll(&mut self) -> io::Result<Vec<LogEntry>> {
        let mut output = Vec::new();
        for state in &mut self.states {
            read_follow_state(state, &mut output)?;
        }
        Ok(output)
    }

    pub(crate) fn flush_pending(&mut self) -> Vec<LogEntry> {
        self.states
            .iter_mut()
            .filter_map(|state| {
                if state.pending.is_empty() {
                    return None;
                }
                let text = String::from_utf8_lossy(&state.pending).into_owned();
                state.pending.clear();
                Some(LogEntry {
                    file: state.source.name.clone(),
                    text: redact_log_line(&text),
                })
            })
            .collect()
    }
}

fn read_follow_state(state: &mut FollowState, output: &mut Vec<LogEntry>) -> io::Result<()> {
    let metadata = match fs::metadata(&state.source.path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let identity = file_identity(&metadata);
    if identity != state.identity {
        state.file = File::open(&state.source.path)?;
        state.identity = file_identity(&state.file.metadata()?);
        state.offset = 0;
        state.pending.clear();
    } else if metadata.len() < state.offset {
        state.file.seek(SeekFrom::Start(0))?;
        state.offset = 0;
        state.pending.clear();
    }
    if metadata.len() == state.offset {
        return Ok(());
    }
    state.file.seek(SeekFrom::Start(state.offset))?;
    let mut remaining = metadata.len().saturating_sub(state.offset);
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let requested = buffer.len().min(remaining as usize);
        let count = state.file.read(&mut buffer[..requested])?;
        if count == 0 {
            break;
        }
        state.offset += count as u64;
        remaining = remaining.saturating_sub(count as u64);
        emit_bytes(state, &buffer[..count], output);
    }
    Ok(())
}

fn emit_bytes(state: &mut FollowState, chunk: &[u8], output: &mut Vec<LogEntry>) {
    for byte in chunk {
        if *byte == b'\n' {
            emit_line(state, output);
        } else {
            state.pending.push(*byte);
        }
    }
    if state.pending.last() == Some(&b'\r') {
        state.pending.pop();
        emit_line(state, output);
    }
}

fn emit_line(state: &mut FollowState, output: &mut Vec<LogEntry>) {
    if state.pending.last() == Some(&b'\r') {
        state.pending.pop();
    }
    if state.pending.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(&state.pending).into_owned();
    state.pending.clear();
    output.push(LogEntry {
        file: state.source.name.clone(),
        text: redact_log_line(&text),
    });
}

fn line_text(bytes: &[u8]) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    text
}

fn file_identity(metadata: &fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

pub(crate) fn redact_log_line(line: &str) -> String {
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static API_KEY: OnceLock<Regex> = OnceLock::new();
    static BOT_TOKEN: OnceLock<Regex> = OnceLock::new();
    let bearer = BEARER.get_or_init(|| Regex::new(r"(?i)(Bearer\s+)[A-Za-z0-9._-]+").unwrap());
    let api_key = API_KEY.get_or_init(|| Regex::new(r"(?i)(OPENAI_API_KEY=)[^\s]+").unwrap());
    let bot = BOT_TOKEN.get_or_init(|| Regex::new(r"bot\d+:[A-Za-z0-9_-]+").unwrap());
    let redacted = bearer.replace_all(line, "$1[redacted]");
    let redacted = api_key.replace_all(&redacted, "$1[redacted]");
    bot.replace_all(&redacted, "bot[redacted]").into_owned()
}
