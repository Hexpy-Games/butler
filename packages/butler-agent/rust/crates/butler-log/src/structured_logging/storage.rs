use super::{
    Config, Preset, Record,
    bodies::Bodies,
    encoded::Encoded,
    index::{self, Block},
    retention,
    segment::{SEGMENT_BYTES, Segment},
};
use std::{collections::BTreeMap, io, path::PathBuf};

pub(crate) type Catalog = BTreeMap<PathBuf, Vec<Block>>;
pub(crate) struct Storage {
    pub root: PathBuf,
    pub catalog: Catalog,
    retention_owner: bool,
    index_versions: BTreeMap<PathBuf, (u64, Option<std::time::SystemTime>)>,
    main: Option<Segment>,
    debug: Option<Segment>,
    last_ts: String,
    bodies: Bodies,
    cleanup: Option<Config>,
    write_errors: [Option<String>; 2],
    written: [bool; 2],
}
impl Storage {
    pub(super) fn open(root: PathBuf, config: &Config) -> io::Result<Self> {
        Self::open_mode(root, config, true)
    }
    pub(super) fn producer(root: PathBuf, config: &Config) -> io::Result<Self> {
        Self::open_mode(root, config, false)
    }
    fn open_mode(root: PathBuf, config: &Config, retention_owner: bool) -> io::Result<Self> {
        butler_platform::secure_fs::create_private_dir_all(&root.join("agent/main"))?;
        let mut this = Self {
            root,
            catalog: Catalog::new(),
            retention_owner,
            index_versions: BTreeMap::new(),
            main: None,
            debug: None,
            last_ts: String::new(),
            bodies: Bodies::default(),
            cleanup: None,
            write_errors: [None, None],
            written: [false, false],
        };
        if !retention_owner {
            return Ok(this);
        }
        let _ = this.configure(config);
        // Pending verbose cleanup must not prevent startup or level reversion.
        if !this.cleanup_pending() {
            for source in ["agent", "app"] {
                retention::prune(&this.root.join(source), &[])?;
            }
        }
        this.discover(true)?;
        if !this.cleanup_pending() {
            this.prune()?;
        }
        this.catalog.retain(|p, _| p.exists());
        Ok(this)
    }
    pub(super) fn refresh(&mut self) -> io::Result<()> {
        self.discover(false)
    }
    fn discover(&mut self, repair: bool) -> io::Result<()> {
        self.catalog.retain(|p, _| p.exists());
        self.index_versions.retain(|p, _| p.exists());
        for source in ["agent", "app"] {
            for lane in ["main", "debug"] {
                for path in retention::files(&self.root.join(source).join(lane))? {
                    if path.extension().is_none_or(|s| s != "jsonl")
                        || self
                            .main
                            .iter()
                            .chain(self.debug.iter())
                            .any(|s| s.path == path)
                    {
                        continue;
                    }
                    let version = std::fs::metadata(path.with_extension("idx"))
                        .ok()
                        .map(|m| (m.len(), m.modified().ok()));
                    if self.catalog.contains_key(&path)
                        && version.as_ref() == self.index_versions.get(&path)
                    {
                        continue;
                    }
                    let blocks = if version.is_some() {
                        index::load(&path)?
                    } else if repair {
                        index::rebuild(&path, source)?
                    } else {
                        continue;
                    };
                    if let Some(version) = version {
                        self.index_versions.insert(path.clone(), version);
                    }
                    self.catalog.insert(path, blocks);
                }
            }
        }
        Ok(())
    }
    pub(super) fn configure(&mut self, config: &Config) -> io::Result<u64> {
        self.cleanup = Some(config.clone());
        self.cleanup()
    }
    pub(super) fn cleanup_pending(&self) -> bool {
        self.cleanup.is_some()
    }
    pub(super) fn cleanup(&mut self) -> io::Result<u64> {
        if !self.retention_owner {
            self.cleanup = None;
            return Ok(0);
        }
        let Some(config) = self.cleanup.clone() else {
            return Ok(0);
        };
        if !config.verbose()
            && let Some(segment) = self.debug.take()
        {
            segment.close()?;
        }
        if config.level != Preset::Full {
            self.bodies.close()?;
        }
        let mut freed = 0;
        for source in ["agent", "app"] {
            if !config.verbose() {
                freed += retention::remove(&self.root.join(source).join("debug"))?;
            }
            if config.level != Preset::Full {
                freed += retention::remove(&self.root.join(source).join("bodies"))?;
            }
        }
        self.catalog.retain(|p, _| p.exists());
        self.cleanup = None;
        Ok(freed)
    }
    pub(super) fn last_write_error(&self) -> Option<String> {
        self.write_errors.iter().flatten().next().cloned()
    }
    pub(super) fn write(&mut self, encoded: Encoded, config: &Config) -> io::Result<Record> {
        let lane = usize::from(super::record::severity(&encoded.level) >= 4);
        let result = self.write_record(encoded, config);
        match &result {
            Ok(_) => self.written[lane] = true,
            Err(error) => {
                self.written[lane] = false;
                self.write_errors[lane] = Some(error.to_string());
            }
        }
        result
    }
    fn write_record(&mut self, mut encoded: Encoded, config: &Config) -> io::Result<Record> {
        let full = config.level == Preset::Full;
        let reference = if full && let Some(body) = &encoded.body {
            match self.bodies.write(&self.root, body) {
                Ok((reference, rotated)) => {
                    if rotated {
                        self.prune()?;
                    }
                    Some(reference)
                }
                Err(error) => {
                    self.bodies = Bodies::default();
                    return Err(error);
                }
            }
        } else {
            None
        };
        let row = encoded.finish(&self.last_ts, full, reference.as_deref())?;
        self.last_ts = row.ts.clone();
        let debug = super::record::severity(&row.level) >= 4;
        let row_bytes = encoded.line.len() as u64;
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
            && let Err(error) = segment.write(&row, &encoded.line)
        {
            // A partial write must never leave a poisoned buffered segment active.
            *slot = None;
            return Err(error);
        }
        Ok(row)
    }
    pub(super) fn flush(&mut self, sync: bool) -> io::Result<()> {
        for (lane, slot) in [&mut self.main, &mut self.debug].into_iter().enumerate() {
            if let Some(s) = slot {
                if let Err(error) = s.flush(sync) {
                    *slot = None;
                    self.written[lane] = false;
                    self.write_errors[lane] = Some(error.to_string());
                    return Err(error);
                }
                if !self.retention_owner {
                    index::save(&s.path, &s.blocks)?;
                }
                self.catalog.insert(s.path.clone(), s.blocks.clone());
                if self.written[lane] {
                    self.write_errors[lane] = None;
                    self.written[lane] = false;
                }
            }
        }
        if sync {
            self.bodies.sync()?;
        }
        Ok(())
    }
    pub(super) fn prune(&mut self) -> io::Result<()> {
        if !self.retention_owner {
            return Ok(());
        }
        if self.cleanup_pending() {
            let _ = self.cleanup();
        }
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
