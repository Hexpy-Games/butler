use super::{Record, record::severity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Write},
    path::Path,
};

pub(crate) const BLOCK_BYTES: u64 = 256 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Block {
    pub offset: u64,
    pub len: u64,
    pub min_ts: String,
    pub max_ts: String,
    pub levels: u8,
    pub source: String,
    pub bloom: Vec<u64>,
}
impl Block {
    pub(super) fn new(offset: u64, source: &str) -> Self {
        Self {
            offset,
            len: 0,
            min_ts: String::new(),
            max_ts: String::new(),
            levels: 0,
            source: source.into(),
            bloom: vec![0; 256],
        }
    }
    pub(super) fn add(&mut self, row: &Record, len: u64) {
        if self.min_ts.is_empty() || row.ts < self.min_ts {
            self.min_ts = row.ts.clone();
        }
        if row.ts > self.max_ts {
            self.max_ts = row.ts.clone();
        }
        self.len += len;
        self.levels |= 1 << severity(&row.level);
        for (kind, id) in [
            ("trace", &row.trace_id),
            ("turn", &row.turn_id),
            ("chat", &row.chat_id),
        ] {
            if let Some(id) = id {
                for bit in bits(kind, id) {
                    self.bloom[bit / 64] |= 1 << (bit % 64);
                }
            }
        }
    }
    pub(super) fn contains(&self, kind: &str, id: &str) -> bool {
        bits(kind, id).into_iter().all(|bit| {
            self.bloom
                .get(bit / 64)
                .is_some_and(|word| word & (1 << (bit % 64)) != 0)
        })
    }
}
fn bits(kind: &str, id: &str) -> [usize; 3] {
    let digest = Sha256::digest(format!("{kind}:{id}").as_bytes());
    std::array::from_fn(|n| {
        (usize::from(digest[n * 2]) * 256 + usize::from(digest[n * 2 + 1])) % 16384
    })
}
pub(crate) fn add(blocks: &mut Vec<Block>, row: &Record, offset: u64, len: u64, source: &str) {
    if blocks.last().is_none_or(|b| b.len + len > BLOCK_BYTES) {
        blocks.push(Block::new(offset, source));
    }
    if let Some(block) = blocks.last_mut() {
        block.add(row, len);
    }
}
pub(crate) fn save(path: &Path, blocks: &[Block]) -> io::Result<()> {
    let tmp = path.with_extension("idx.tmp");
    let mut file = super::files::create(&tmp, false)?;
    serde_json::to_writer(&mut file, blocks)?;
    file.flush()?;
    super::files::sync(&file)?;
    butler_platform::secure_fs::rename(&tmp, &path.with_extension("idx"))?;
    super::files::sync_parent(path)
}
pub(crate) fn load(path: &Path) -> io::Result<Vec<Block>> {
    Ok(serde_json::from_reader(BufReader::new(File::open(
        path.with_extension("idx"),
    )?))?)
}
/// Startup repair only. Bound malformed line allocation as well as normal read blocks.
pub(crate) fn rebuild(path: &Path, source: &str) -> io::Result<Vec<Block>> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut blocks = Vec::new();
    let mut offset = 0;
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            break;
        }
        let end = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |n| n + 1);
        let complete = buffer.get(end - 1) == Some(&b'\n');
        if !oversized && line.len() + end <= 1024 * 1024 {
            line.extend_from_slice(&buffer[..end]);
        } else {
            oversized = true;
        }
        reader.consume(end);
        offset += u64::try_from(end).map_err(io::Error::other)?;
        if complete {
            if !oversized && let Ok(row) = serde_json::from_slice::<Record>(&line) {
                let len = u64::try_from(line.len()).map_err(io::Error::other)?;
                add(&mut blocks, &row, offset - len, len, source);
            }
            line.clear();
            oversized = false;
        }
    }
    save(path, &blocks)?;
    Ok(blocks)
}
