//! Pin read snapshots so checkpoints cannot recycle frames during measurement.
//! Count SQLite commit frames, rather than treating data_version as commit count.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct Wal {
    pub(crate) name: String,
    path: PathBuf,
    _reader: Connection,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Sample {
    salt: [u8; 8],
    pub(crate) bytes: u64,
    pub(crate) commits: usize,
}

impl Wal {
    pub(crate) fn pin(data: &Path, relative: &str) -> Result<Self, HarnessError> {
        let database = data.join(relative);
        let reader = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        reader.execute_batch("BEGIN; SELECT rootpage FROM sqlite_master LIMIT 1;")?;
        Ok(Self {
            name: relative.to_owned(),
            path: PathBuf::from(format!("{}-wal", database.display())),
            _reader: reader,
        })
    }

    pub(crate) fn sample(&self) -> Result<Sample, HarnessError> {
        let raw = match fs::read(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        if raw.is_empty() {
            return Ok(Sample {
                salt: [0; 8],
                bytes: 0,
                commits: 0,
            });
        }
        assert!(raw.len() >= 32, "{}: missing WAL header", self.name);
        let magic = u32::from_be_bytes(raw[..4].try_into().unwrap());
        assert!(matches!(magic, 0x377f_0682 | 0x377f_0683));
        let little = magic == 0x377f_0682;
        let page = u32::from_be_bytes(raw[8..12].try_into().unwrap()) as usize;
        let salt: [u8; 8] = raw[16..24].try_into().unwrap();
        let mut sum = checksum(&raw[..24], [0; 2], little);
        assert_eq!(sum, stored_checksum(&raw[24..32]));
        let mut frames = 0;
        let mut commits = 0;
        for frame in raw[32..].chunks_exact(page + 24) {
            if frame[8..16] != salt {
                break;
            }
            let next = checksum(&frame[24..], checksum(&frame[..8], sum, little), little);
            if next != stored_checksum(&frame[16..24]) {
                break;
            }
            sum = next;
            frames += 1;
            if u32::from_be_bytes(frame[4..8].try_into().unwrap()) != 0 {
                commits += 1;
            }
        }
        Ok(Sample {
            salt,
            bytes: frames * (page as u64 + 24),
            commits,
        })
    }

    pub(crate) fn delta(&self, before: Sample) -> Result<(u64, usize), HarnessError> {
        let after = self.sample()?;
        if before.bytes > 0 {
            assert_eq!(
                after.salt, before.salt,
                "{}: WAL recycled despite pinned reader",
                self.name
            );
        }
        assert!(after.bytes >= before.bytes && after.commits >= before.commits);
        Ok((after.bytes - before.bytes, after.commits - before.commits))
    }
}

fn checksum(bytes: &[u8], mut sum: [u32; 2], little: bool) -> [u32; 2] {
    for pair in bytes.chunks_exact(8) {
        let word = |bytes: &[u8]| {
            if little {
                u32::from_le_bytes(bytes.try_into().unwrap())
            } else {
                u32::from_be_bytes(bytes.try_into().unwrap())
            }
        };
        sum[0] = sum[0].wrapping_add(word(&pair[..4])).wrapping_add(sum[1]);
        sum[1] = sum[1].wrapping_add(word(&pair[4..])).wrapping_add(sum[0]);
    }
    sum
}

fn stored_checksum(bytes: &[u8]) -> [u32; 2] {
    [
        u32::from_be_bytes(bytes[..4].try_into().unwrap()),
        u32::from_be_bytes(bytes[4..].try_into().unwrap()),
    ]
}
