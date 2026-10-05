//! Compare committed source revisions, retaining the reader to avoid self-wake loops.
use butler_turn::conversation::ConversationSourceReader;
use std::{io, path::PathBuf};

#[derive(PartialEq, Eq)]
struct Identity {
    id: Option<butler_platform::secure_fs::FileId>,
    created: Option<butler_platform::secure_fs::FileTime>,
}
pub(super) struct SourceProbe {
    path: PathBuf,
    identity: Option<Identity>,
    reader: Option<ConversationSourceReader>,
    revision: Option<(Option<String>, u64)>,
}
impl SourceProbe {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            identity: None,
            reader: None,
            revision: None,
        }
    }
    pub(super) fn changed(&mut self) -> io::Result<bool> {
        let metadata = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.identity = None;
                self.reader = None;
                return Ok(self.revision.take().is_some());
            }
            Err(error) => return Err(error),
        };
        let file = butler_platform::secure_fs::identity(&metadata);
        let identity = Identity {
            id: file.id,
            created: file.id.is_none().then_some(file.changed).flatten(),
        };
        if self.identity.as_ref() != Some(&identity) {
            self.reader = None;
            self.identity = Some(identity);
        }
        if self.reader.is_none() {
            self.reader =
                Some(ConversationSourceReader::open(&self.path).map_err(|error| failed(&error))?);
        }
        let reader = self
            .reader
            .as_ref()
            .ok_or_else(|| io::Error::other("Source reader unavailable"))?;
        let revision = (
            reader.source_identity().map_err(|error| failed(&error))?,
            reader.public_revision().map_err(|error| failed(&error))?,
        );
        let changed = self.revision.as_ref() != Some(&revision);
        self.revision = Some(revision);
        if std::env::var("BUTLER_E2E_MEMORY_SYNC_TRACE").as_deref() == Ok("1") {
            butler_core::diagnostic!(
                "[memory-source-trace] committed_revision={} changed={changed}",
                self.revision.as_ref().map_or(0, |(_, revision)| *revision)
            );
        }
        Ok(changed)
    }
}
fn failed(error: &butler_turn::conversation::ConversationError) -> io::Error {
    io::Error::other(error.code().to_owned())
}
