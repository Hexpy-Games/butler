//! Append independent zstd frames; references never expose arbitrary paths.
use super::segment::SEGMENT_BYTES;
use butler_platform::data_paths;
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(super) struct Bodies {
    active: Option<(PathBuf, File, u64)>,
}
impl Bodies {
    pub(super) fn write(&mut self, root: &Path, bytes: &[u8]) -> io::Result<(String, bool)> {
        let mut compressed = Vec::new();
        let frame_bytes = usize::try_from(SEGMENT_BYTES / 2).map_err(io::Error::other)?;
        let mut frames = 0_u64;
        for chunk in bytes.chunks(frame_bytes) {
            zstd::stream::copy_encode(chunk, &mut compressed, 1)?;
            frames += 1;
        }
        let len = u64::try_from(compressed.len()).map_err(io::Error::other)?;
        let rotated = self
            .active
            .as_ref()
            .is_some_and(|(_, _, n)| *n + len > SEGMENT_BYTES);
        if rotated {
            self.close()?;
        }
        if self.active.is_none() {
            let dir = root.join(data_paths::NATIVE_LOG_STORE).join("bodies");
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
        let reference = if frames > 1 {
            format!("{name}:{offset}:{len}:{frames}")
        } else {
            format!("{name}:{offset}:{len}")
        };
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
        || !matches!(parts.len(), 3 | 4)
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
    let frames = parts
        .get(3)
        .map_or(Ok(1), |value| value.parse::<u64>())
        .map_err(|_| invalid("invalid body frame count"))?;
    if len == 0 || frames == 0 || frames > len || frames == 1 && len > SEGMENT_BYTES {
        return Err(invalid("invalid body length"));
    }
    for &source in data_paths::OWNED_LOG_STORES {
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
        return read_frames(file.take(len), frames);
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "body expired"))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Each compressed frame is independently bounded, including multipart bodies.
/// The reference's encoded range must end exactly at its final frame.
fn read_frames(input: impl Read, frames: u64) -> io::Result<Vec<u8>> {
    let mut input = BufReader::new(input);
    let mut bytes = Vec::new();
    for _ in 0..frames {
        let start = bytes.len();
        let decoder = zstd::stream::read::Decoder::with_buffer(&mut input)?.single_frame();
        decoder.take(SEGMENT_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() == start || (bytes.len() - start) as u64 > SEGMENT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "decoded body frame exceeds limit",
            ));
        }
    }
    if !input.fill_buf()?.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "trailing body frames",
        ));
    }
    Ok(bytes)
}
