//! Append independent zstd frames; references never expose arbitrary paths.
use super::{retention, segment::SEGMENT_BYTES};
use std::{
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(super) struct Bodies {
    active: Option<(PathBuf, File, u64)>,
}
impl Bodies {
    pub(super) fn write(&mut self, root: &Path, bytes: &[u8]) -> io::Result<String> {
        let compressed = zstd::encode_all(bytes, 1)?;
        let len = u64::try_from(compressed.len()).map_err(io::Error::other)?;
        if self
            .active
            .as_ref()
            .is_some_and(|(_, _, n)| *n + len > SEGMENT_BYTES)
        {
            self.close()?;
            retention::prune(&root.join("agent"))?;
        }
        if self.active.is_none() {
            let dir = root.join("agent/bodies");
            butler_platform::secure_fs::create_private_dir_all(&dir)?;
            let path = dir.join(format!(
                "{}-{}.zst",
                chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
                uuid::Uuid::new_v4()
            ));
            let file = super::files::create(&path, true)?;
            self.active = Some((path, file, 0));
        }
        let Some((path, file, offset)) = self.active.as_mut() else {
            return Err(io::Error::other("body segment unavailable"));
        };
        file.write_all(&compressed)?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| io::Error::other("invalid body segment"))?;
        let reference = format!("{name}:{offset}:{len}");
        *offset += len;
        Ok(reference)
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        if let Some((path, file, _)) = &self.active {
            file.sync_all()?;
            super::files::sync_parent(path)?;
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> io::Result<()> {
        self.sync()?;
        self.active = None;
        Ok(())
    }
}
pub(super) fn read(root: &Path, reference: &str) -> io::Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let parts: Vec<_> = reference.split(':').collect();
    let name = parts.first().copied().unwrap_or_default();
    if name.contains(['/', '\\'])
        || !name.ends_with(".zst")
        || name.contains("..")
        || !matches!(parts.len(), 1 | 3)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid body reference",
        ));
    }
    let range = if parts.len() == 3 {
        let start = parts[1]
            .parse::<u64>()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid body offset"))?;
        let len = parts[2]
            .parse::<u64>()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid body length"))?;
        Some((start, len))
    } else {
        None
    };
    for source in ["agent", "app"] {
        let path = root.join(source).join("bodies").join(name);
        if !path.is_file() {
            continue;
        }
        let mut file = butler_platform::secure_fs::open_read_no_follow(&path)?;
        return if let Some((offset, len)) = range {
            if offset
                .checked_add(len)
                .is_none_or(|end| end > file.metadata().map_or(0, |m| m.len()))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid body range",
                ));
            }
            file.seek(SeekFrom::Start(offset))?;
            zstd::decode_all(file.take(len))
        } else {
            zstd::decode_all(file)
        };
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "body expired"))
}
