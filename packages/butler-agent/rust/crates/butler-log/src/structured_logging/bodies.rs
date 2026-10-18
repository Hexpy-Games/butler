//! Append independent zstd frames; references never expose arbitrary paths.
use super::segment::SEGMENT_BYTES;
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
    pub(super) fn write(&mut self, root: &Path, bytes: &[u8]) -> io::Result<(String, bool)> {
        let compressed = zstd::encode_all(bytes, 1)?;
        let len = u64::try_from(compressed.len()).map_err(io::Error::other)?;
        let rotated = self
            .active
            .as_ref()
            .is_some_and(|(_, _, n)| *n + len > SEGMENT_BYTES);
        if rotated {
            self.close()?;
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
        Ok((reference, rotated))
    }
    pub(super) fn path(&self) -> Option<&PathBuf> {
        self.active.as_ref().map(|(p, _, _)| p)
    }
    pub(super) fn sync(&self) -> io::Result<()> {
        if let Some((path, file, _)) = &self.active {
            super::files::sync(file)?;
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
        || parts.len() != 3
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid body reference",
        ));
    }
    let offset = parts[1]
        .parse::<u64>()
        .map_err(|_| invalid("invalid body offset"))?;
    let len = parts[2]
        .parse::<u64>()
        .map_err(|_| invalid("invalid body length"))?;
    if len == 0 || len > SEGMENT_BYTES {
        return Err(invalid("invalid body length"));
    }
    for source in ["agent", "app"] {
        let path = root.join(source).join("bodies").join(name);
        if !path.is_file() {
            continue;
        }
        let mut file = butler_platform::secure_fs::open_read_no_follow(&path)?;
        if offset
            .checked_add(len)
            .is_none_or(|end| end > file.metadata().map_or(0, |m| m.len()))
        {
            return Err(invalid("invalid body range"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let decoder = zstd::stream::read::Decoder::new(file.take(len))?;
        let mut bytes = Vec::new();
        decoder.take(SEGMENT_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > SEGMENT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "decoded body exceeds limit",
            ));
        }
        return Ok(bytes);
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "body expired"))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
