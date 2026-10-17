//! Serialized transcript appends; only step boundaries publish durable bytes.
use super::{TranscriptError, TranscriptResult, TranscriptVisibility, event::TranscriptEvent};
use crate::gateway::{TranscriptCode, command_timing::CommandTiming};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
};

struct Pending {
    first_create: bool,
    pair: bool,
}

pub(super) struct Writer {
    directory: PathBuf,
    visibility: TranscriptVisibility,
    pending: HashMap<String, Pending>,
    directory_synced: bool,
}

impl Writer {
    pub(super) fn new(directory: PathBuf, visibility: TranscriptVisibility) -> Self {
        Self {
            directory,
            visibility,
            pending: HashMap::new(),
            directory_synced: false,
        }
    }

    pub(super) fn append(
        &mut self,
        session: &str,
        events: &[TranscriptEvent],
        durable: bool,
    ) -> TranscriptResult<Option<String>> {
        let name = file_name(session);
        if !events.is_empty() {
            let timing = CommandTiming::new("transcript_append");
            let bytes = encode(events)?;
            butler_platform::secure_fs::create_private_dir_all(&self.directory)
                .map_err(io_error)?;
            let existed = self.directory.join(&name).try_exists().map_err(io_error)?;
            let mut file = self.open(&name, true)?;
            if !self.pending.contains_key(&name) {
                self.visibility
                    .publish(name.clone(), file.metadata().map_err(io_error)?.len());
                self.pending.insert(
                    name.clone(),
                    Pending {
                        first_create: !existed,
                        pair: false,
                    },
                );
            }
            let pending = self.pending.get_mut(&name).ok_or_else(|| {
                io_error(std::io::Error::other("Transcript append state missing"))
            })?;
            pending.pair |= events.len() > 1;
            file.write_all(&bytes).map_err(io_error)?;
            timing.mark("written");
        }
        if durable { self.sync(&name) } else { Ok(None) }
    }

    fn open(&self, name: &str, create: bool) -> TranscriptResult<File> {
        let mut options = OpenOptions::new();
        options.create(create).append(true);
        butler_platform::secure_fs::owner_only(&mut options);
        butler_platform::secure_fs::no_follow(&mut options);
        let file = options.open(self.directory.join(name)).map_err(io_error)?;
        butler_platform::secure_fs::restrict_open_file(&file)
            .unwrap_or(Ok(()))
            .map_err(io_error)?;
        Ok(file)
    }

    fn sync(&mut self, name: &str) -> TranscriptResult<Option<String>> {
        let Some((first_create, pair)) = self
            .pending
            .get(name)
            .map(|pending| (pending.first_create, pending.pair))
        else {
            return Ok(None);
        };
        let timing = CommandTiming::new("transcript_sync");
        self.open(name, false)?.sync_data().map_err(io_error)?;
        timing.mark("synced");
        // Also cover an existing entry left by a process crash before its first boundary.
        if first_create || !self.directory_synced {
            butler_platform::secure_fs::sync_directory(&self.directory)
                .unwrap_or(Ok(()))
                .map_err(io_error)?;
            self.directory_synced = true;
            if let Some(pending) = self.pending.get_mut(name) {
                pending.first_create = false;
            }
        }
        // Complete pairs and file/directory sync precede this crash window,
        // projection notification, and the dependent acknowledgement.
        if pair {
            butler_platform::secure_fs::fault_checkpoint("transcript_pair").map_err(io_error)?;
        }
        butler_platform::secure_fs::hold_point("transcript_step_synced", || false)
            .map_err(io_error)?;
        self.visibility.release(name);
        self.pending.remove(name);
        Ok(Some(name.to_owned()))
    }

    pub(super) fn close(&mut self) -> TranscriptResult<()> {
        for name in self.pending.keys().cloned().collect::<Vec<_>>() {
            self.sync(&name)?;
        }
        Ok(())
    }
}

fn file_name(session: &str) -> String {
    format!(
        "{}.jsonl",
        session
            .encode_utf16()
            .map(|unit| match u8::try_from(unit) {
                Ok(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') =>
                    char::from(byte),
                _ => '_',
            })
            .collect::<String>()
    )
}

fn encode(events: &[TranscriptEvent]) -> TranscriptResult<Vec<u8>> {
    let mut bytes = Vec::new();
    for event in events {
        serde_json::to_writer(&mut bytes, event).map_err(|error| {
            TranscriptError::new(
                TranscriptCode::TranscriptEventJsonInvalid,
                error.to_string(),
            )
            .with_source(error)
        })?;
        bytes.push(b'\n');
    }
    Ok(bytes)
}

fn io_error(error: std::io::Error) -> TranscriptError {
    TranscriptError::new(TranscriptCode::TranscriptAppendFailed, error.to_string())
        .with_source(error)
}
