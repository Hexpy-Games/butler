use super::{
    Record,
    index::{self, Block},
};
use std::{
    fs::File,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
};

pub(crate) const SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) struct Segment {
    pub path: PathBuf,
    pub bytes: u64,
    pub blocks: Vec<Block>,
    file: BufWriter<File>,
    dirty: bool,
    index_dirty_from: Option<usize>,
}
impl Segment {
    pub(super) fn open(dir: &Path) -> io::Result<Self> {
        butler_platform::secure_fs::create_private_dir_all(dir)?;
        let prefix = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        for n in 1..=u32::MAX {
            let path = dir.join(format!("{prefix}-{n:04}.jsonl"));
            match super::files::create(&path, true) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: BufWriter::new(file),
                        bytes: 0,
                        blocks: Vec::new(),
                        dirty: false,
                        index_dirty_from: None,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::other("log segment sequence exhausted"))
    }
    pub(super) fn write(&mut self, row: &Record, line: &[u8]) -> io::Result<()> {
        let len = u64::try_from(line.len()).map_err(io::Error::other)?;
        self.file.write_all(line)?;
        self.index_dirty_from
            .get_or_insert(self.blocks.len().saturating_sub(1));
        index::add(&mut self.blocks, row, self.bytes, len, "agent");
        self.bytes += len;
        self.dirty = true;
        Ok(())
    }
    pub(super) fn flush(&mut self, sync: bool) -> io::Result<()> {
        if self.dirty {
            self.file.flush()?;
            self.dirty = false;
        }
        if sync {
            super::files::sync(self.file.get_ref())?;
            super::files::sync_parent(&self.path)?;
        }
        Ok(())
    }
    pub(super) fn publish(&mut self, catalog: &mut super::storage::Catalog) {
        let Some(from) = self.index_dirty_from.take() else {
            return;
        };
        let blocks = catalog.entry(self.path.clone()).or_default();
        // Only the last existing block can change; earlier blocks are immutable.
        blocks.truncate(from);
        blocks.extend_from_slice(&self.blocks[from..]);
    }
    pub(super) fn close(mut self) -> io::Result<()> {
        self.flush(true)?;
        index::save(&self.path, &self.blocks)
    }
}
