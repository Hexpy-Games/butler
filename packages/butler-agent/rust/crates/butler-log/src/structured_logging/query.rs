use super::{Record, index::Block, record::severity, storage::Catalog};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const SCAN_LIMIT: u64 = 32 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct Query {
    pub source: String,
    pub level: Option<String>,
    pub category: Option<String>,
    pub q: Option<String>,
    pub trace_id: Option<String>,
    pub turn_id: Option<String>,
    pub chat_id: Option<String>,
    pub message_id: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub cursor: Option<String>,
    pub limit: usize,
}
impl Default for Query {
    fn default() -> Self {
        Self {
            source: "all".into(),
            level: None,
            category: None,
            q: None,
            trace_id: None,
            turn_id: None,
            chat_id: None,
            message_id: None,
            since: None,
            until: None,
            cursor: None,
            limit: 200,
        }
    }
}
#[derive(Serialize)]
pub struct Page {
    pub rows: Vec<Record>,
    pub cursor: Option<String>,
    pub scanned_bytes: u64,
    pub exhausted: bool,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    positions: BTreeMap<String, u64>,
    filter: String,
}
struct Reader {
    path: PathBuf,
    name: String,
    blocks: Vec<Block>,
    pos: u64,
    buffered: Vec<(u64, Record)>,
    front: Option<(u64, Record)>,
}
impl Query {
    fn block_matches(&self, b: &Block) -> bool {
        self.since.as_ref().is_none_or(|s| b.max_ts >= *s)
            && self.until.as_ref().is_none_or(|s| b.min_ts <= *s)
            && self
                .level
                .as_ref()
                .is_none_or(|s| b.levels & (1 << severity(s)) != 0)
            && [
                ("trace", &self.trace_id),
                ("turn", &self.turn_id),
                ("chat", &self.chat_id),
                ("message", &self.message_id),
            ]
            .into_iter()
            .all(|(kind, id)| id.as_ref().is_none_or(|id| b.contains(kind, id)))
    }
    fn matches(&self, r: &Record) -> bool {
        self.level
            .as_ref()
            .is_none_or(|s| r.level.eq_ignore_ascii_case(s))
            && self.category.as_ref().is_none_or(|s| {
                r.category == *s
                    || r.category
                        .strip_prefix(s)
                        .is_some_and(|v| v.starts_with('.'))
            })
            && self.since.as_ref().is_none_or(|s| r.ts >= *s)
            && self.until.as_ref().is_none_or(|s| r.ts <= *s)
            && [
                (&self.trace_id, &r.trace_id),
                (&self.turn_id, &r.turn_id),
                (&self.chat_id, &r.chat_id),
            ]
            .into_iter()
            .all(|(q, r)| q.as_ref().is_none_or(|q| Some(q) == r.as_ref()))
            && self
                .message_id
                .as_deref()
                .is_none_or(|id| r.attrs["message_id"].as_str() == Some(id))
            && self
                .q
                .as_ref()
                .is_none_or(|q| serde_json::to_string(r).is_ok_and(|s| s.contains(q)))
    }
    fn fingerprint(&self) -> io::Result<String> {
        let mut query = self.clone();
        query.cursor = None;
        query.limit = 0;
        Ok(serde_json::to_string(&query)?)
    }
}
impl Reader {
    fn upper_bound(&self) -> Option<(&str, &str, u64)> {
        if let Some((offset, row)) = &self.front {
            return Some((&row.ts, &self.name, *offset));
        }
        self.blocks
            .iter()
            .rev()
            .find(|block| block.offset < self.pos)
            .map(|block| (block.max_ts.as_str(), self.name.as_str(), self.pos))
    }
    /// False means the scan budget was reached before this source's next row.
    fn advance(&mut self, q: &Query, scanned: &mut u64) -> io::Result<bool> {
        let mut loaded = false;
        loop {
            if self.front.is_some() || self.pos == 0 {
                return Ok(true);
            }
            while let Some((offset, row)) = self.buffered.pop() {
                if offset >= self.pos {
                    continue;
                }
                if q.matches(&row) {
                    self.front = Some((offset, row));
                    return Ok(true);
                }
                self.pos = offset;
            }
            if loaded {
                return Ok(true);
            }
            let Some(b) = self.blocks.iter().rev().find(|b| b.offset < self.pos) else {
                self.pos = 0;
                return Ok(true);
            };
            if *scanned + b.len > SCAN_LIMIT {
                return Ok(false);
            }
            let mut file = match File::open(&self.path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    self.pos = 0;
                    return Ok(true);
                }
                Err(error) => return Err(error),
            };
            file.seek(SeekFrom::Start(b.offset))?;
            let mut bytes = vec![0; usize::try_from(b.len).map_err(io::Error::other)?];
            file.read_exact(&mut bytes)?;
            *scanned += b.len;
            loaded = true;
            let mut offset = b.offset;
            for line in bytes.split_inclusive(|b| *b == b'\n') {
                if offset < self.pos
                    && let Ok(row) = serde_json::from_slice(line)
                {
                    self.buffered.push((offset, row));
                }
                offset += u64::try_from(line.len()).map_err(io::Error::other)?;
            }
            if self.buffered.is_empty() {
                self.pos = b.offset;
            }
        }
    }
}
pub(crate) fn query(root: &Path, catalog: &Catalog, q: &Query) -> io::Result<Page> {
    query_bounded(root, catalog, q, 200)
}
pub(crate) fn query_bounded(
    root: &Path,
    catalog: &Catalog,
    q: &Query,
    maximum: usize,
) -> io::Result<Page> {
    let mut normalized = q.clone();
    normalized.since = timestamp(q.since.as_deref())?;
    normalized.until = timestamp(q.until.as_deref())?;
    let q = &normalized;
    if !matches!(q.source.as_str(), "agent" | "app" | "all")
        || q.level.as_ref().is_some_and(|l| severity(l) == 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid log filter",
        ));
    }
    let filter = q.fingerprint()?;
    let cursor = q
        .cursor
        .as_ref()
        .map(|s| {
            let bytes = URL_SAFE_NO_PAD
                .decode(s)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid log cursor"))?;
            let c: Cursor = serde_json::from_slice(&bytes)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid log cursor"))?;
            if c.filter != filter {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "cursor filter changed",
                ));
            }
            Ok(c)
        })
        .transpose()?;
    let mut readers = Vec::new();
    for (path, blocks) in catalog.iter().rev() {
        let relative = path.strip_prefix(root).map_err(io::Error::other)?;
        let name = relative.to_string_lossy().into_owned();
        if q.source != "all" && !relative.starts_with(&q.source) {
            continue;
        }
        let end = blocks.last().map_or(0, |b| b.offset + b.len);
        let pos = cursor
            .as_ref()
            .map_or(end, |c| c.positions.get(&name).copied().unwrap_or(0))
            .min(end);
        readers.push(Reader {
            path: path.clone(),
            name,
            blocks: blocks
                .iter()
                .filter(|block| block.offset < pos && q.block_matches(block))
                .cloned()
                .collect(),
            pos,
            buffered: Vec::new(),
            front: None,
        });
    }
    merge(readers, q, filter, maximum)
}
fn merge(mut readers: Vec<Reader>, q: &Query, filter: String, maximum: usize) -> io::Result<Page> {
    let mut rows = Vec::new();
    let mut scanned = 0;
    loop {
        let next = readers
            .iter()
            .enumerate()
            .filter_map(|(i, reader)| reader.upper_bound().map(|key| (i, key)))
            .max_by(|(_, a), (_, b)| a.cmp(b))
            .map(|(i, _)| i);
        let Some(next) = next else {
            break;
        };
        if readers[next].front.is_none() {
            if !readers[next].advance(q, &mut scanned)? {
                break;
            }
            continue;
        }
        if let Some((offset, row)) = readers[next].front.take() {
            readers[next].pos = offset;
            rows.push(row);
        }
        if rows.len() >= q.limit.clamp(1, maximum) {
            break;
        }
    }
    let exhausted = readers.iter().all(|r| r.upper_bound().is_none());
    let cursor = if exhausted {
        None
    } else {
        let positions = readers.into_iter().map(|r| (r.name, r.pos)).collect();
        Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor { positions, filter })?))
    };
    Ok(Page {
        rows,
        cursor,
        scanned_bytes: scanned,
        exhausted,
    })
}

pub(super) fn timestamp(value: Option<&str>) -> io::Result<Option<String>> {
    value
        .map(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|date| {
                    date.to_utc()
                        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
                })
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid log timestamp"))
        })
        .transpose()
}
