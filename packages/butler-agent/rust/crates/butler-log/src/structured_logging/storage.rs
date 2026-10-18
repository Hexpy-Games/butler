use super::{
    Config, Preset, Record,
    bodies::Bodies,
    index::{self, Block},
    redaction, retention,
    segment::{SEGMENT_BYTES, Segment},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io, path::PathBuf};

pub(crate) type Catalog = BTreeMap<PathBuf, Vec<Block>>;
pub(crate) struct Storage {
    pub root: PathBuf,
    pub catalog: Catalog,
    main: Option<Segment>,
    debug: Option<Segment>,
    last_ts: String,
    bodies: Bodies,
}
impl Storage {
    pub(super) fn open(root: PathBuf, config: &Config) -> io::Result<Self> {
        butler_platform::secure_fs::create_private_dir_all(&root.join("agent/main"))?;
        for source in ["agent", "app"] {
            retention::prune(&root.join(source), &[])?;
        }
        let mut this = Self {
            root,
            catalog: Catalog::new(),
            main: None,
            debug: None,
            last_ts: String::new(),
            bodies: Bodies::default(),
        };
        this.configure(config)?;
        this.discover(true)?;
        this.prune()?;
        this.catalog.retain(|p, _| p.exists());
        Ok(this)
    }
    pub(super) fn refresh(&mut self) -> io::Result<()> {
        self.discover(false)
    }
    fn discover(&mut self, repair: bool) -> io::Result<()> {
        self.catalog.retain(|p, _| p.exists());
        for source in ["agent", "app"] {
            for lane in ["main", "debug"] {
                for path in retention::files(&self.root.join(source).join(lane))? {
                    if path.extension().is_none_or(|s| s != "jsonl")
                        || self.catalog.contains_key(&path)
                    {
                        continue;
                    }
                    let blocks = if path.with_extension("idx").exists() {
                        index::load(&path)?
                    } else if repair {
                        index::rebuild(&path, source)?
                    } else {
                        continue;
                    };
                    self.catalog.insert(path, blocks);
                }
            }
        }
        Ok(())
    }
    pub(super) fn configure(&mut self, config: &Config) -> io::Result<u64> {
        let mut freed = 0;
        if !config.verbose() {
            if let Some(segment) = self.debug.take() {
                segment.close()?;
            }
            for source in ["agent", "app"] {
                freed += retention::remove(&self.root.join(source).join("debug"))?;
            }
        }
        if config.level != Preset::Full {
            self.bodies.close()?;
            for source in ["agent", "app"] {
                freed += retention::remove(&self.root.join(source).join("bodies"))?;
            }
        }
        self.catalog.retain(|p, _| p.exists());
        Ok(freed)
    }
    pub(super) fn write(&mut self, mut row: Record, config: &Config) -> io::Result<Record> {
        row.level = row.level.to_ascii_uppercase();
        // Multiple producers may enqueue in a different order than their clocks.
        // A nondecreasing writer clock makes each segment a mergeable stream.
        if row.ts < self.last_ts {
            row.ts = self.last_ts.clone();
        }
        self.last_ts = row.ts.clone();
        self.prepare(&mut row, config)?;
        let debug = super::record::severity(&row.level) >= 4;
        let row_bytes =
            u64::try_from(serde_json::to_vec(&row)?.len() + 1).map_err(io::Error::other)?;
        let rotate = if debug { &self.debug } else { &self.main }
            .as_ref()
            .is_some_and(|s| s.bytes > 0 && s.bytes + row_bytes > SEGMENT_BYTES);
        if rotate {
            let previous = if debug {
                self.debug.take()
            } else {
                self.main.take()
            };
            if let Some(segment) = previous {
                self.catalog
                    .insert(segment.path.clone(), segment.blocks.clone());
                segment.close()?;
            }
            self.prune()?;
            self.catalog.retain(|p, _| p.exists());
        }
        let slot = if debug {
            &mut self.debug
        } else {
            &mut self.main
        };
        if slot.is_none() {
            *slot = Some(Segment::open(&self.root.join("agent").join(if debug {
                "debug"
            } else {
                "main"
            }))?);
        }
        if let Some(segment) = slot
            && let Err(error) = segment.write(&row)
        {
            // A partial write must never leave a poisoned buffered segment active.
            *slot = None;
            return Err(error);
        }
        Ok(row)
    }
    fn prepare(&mut self, row: &mut Record, config: &Config) -> io::Result<()> {
        if let Some(content) = row.content.take() {
            let bytes = serde_json::to_vec(&content)?;
            row.content_len = Some(bytes.len());
            row.content_hash = Some(format!("{:x}", Sha256::digest(&bytes))[..8].into());
            if config.level == Preset::Full {
                let content = redaction::redact_json(&content);
                let bytes = serde_json::to_vec(&content)?;
                if bytes.len() > 8192 {
                    let result = self.bodies.write(&self.root, &bytes);
                    let (reference, rotated) = match result {
                        Ok(result) => result,
                        Err(error) => {
                            self.bodies = Bodies::default();
                            return Err(error);
                        }
                    };
                    row.body_ref = Some(reference);
                    if rotated {
                        self.prune()?;
                    }
                } else {
                    row.content = Some(content);
                }
            }
        }
        let mut value = serde_json::to_value(&row)?;
        // Schema keys are fixed identifiers; nested producer keys are untrusted.
        if let Some(fields) = value.as_object_mut() {
            for field in fields.values_mut() {
                *field = redaction::scrub_value(field, true);
            }
        }
        *row = serde_json::from_value::<Record>(value)?;
        Ok(())
    }
    pub(super) fn flush(&mut self, sync: bool) -> io::Result<()> {
        for slot in [&mut self.main, &mut self.debug] {
            if let Some(s) = slot {
                if let Err(error) = s.flush(sync) {
                    *slot = None;
                    return Err(error);
                }
                self.catalog.insert(s.path.clone(), s.blocks.clone());
            }
        }
        if sync {
            self.bodies.sync()?;
        }
        Ok(())
    }
    pub(super) fn prune(&self) -> io::Result<()> {
        let active = self
            .main
            .iter()
            .chain(self.debug.iter())
            .map(|s| s.path.clone())
            .chain(self.bodies.path().cloned())
            .collect::<Vec<_>>();
        retention::prune(&self.root.join("agent"), &active)
    }

    pub(super) fn close(&mut self) -> io::Result<()> {
        self.bodies.close()?;
        if let Some(s) = self.main.take() {
            s.close()?;
        }
        if let Some(s) = self.debug.take() {
            s.close()?;
        }
        self.prune()
    }
    pub(super) fn clear(&mut self) -> io::Result<u64> {
        self.close()?;
        let mut bytes = 0;
        for source in ["agent", "app"] {
            for lane in ["main", "debug", "bodies"] {
                bytes += retention::remove(&self.root.join(source).join(lane))?;
            }
        }
        self.catalog.retain(|p, _| p.exists());
        Ok(bytes)
    }
}
