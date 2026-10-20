//! Streaming compaction with a stable cross-process publication lane. The live
//! path is never replaced until every append through the captured EOF is copied.

use super::*;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom};

#[derive(PartialEq, Eq)]
struct Stamp {
    len: u64,
    identity: butler_platform::secure_fs::FileIdentity,
}

impl Stamp {
    fn read(path: &Path) -> io::Result<Self> {
        let metadata = butler_platform::secure_fs::current_metadata(path)?;
        Ok(Self {
            len: metadata.len(),
            identity: butler_platform::secure_fs::identity(&metadata),
        })
    }
}

pub(super) struct Snapshot {
    stamp: Stamp,
    earliest: f64,
    threshold: f64,
    kept: usize,
}

pub(super) fn retain(
    files: &MetricFiles,
    file: MetricFile,
    threshold: f64,
    snapshot: &mut Option<Snapshot>,
) -> io::Result<MetricRetentionStats> {
    // A separate lane serializes compactions without stopping appenders during
    // a large scan. All publishers take retention before append, never reverse.
    let _retention = files.file_lock(file, "retention")?;
    let path = files.metric_directory().join(file.file_name());
    let stamp = match Stamp::read(&path) {
        Ok(stamp) => stamp,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            *snapshot = None;
            return Ok(MetricRetentionStats::default());
        }
        Err(error) => return Err(error),
    };
    if let Some(previous) = snapshot
        && previous.stamp == stamp
        && stamp.identity.modified.is_some()
        && threshold >= previous.threshold
        && threshold <= previous.earliest
    {
        return Ok(MetricRetentionStats {
            kept: previous.kept,
            ..MetricRetentionStats::default()
        });
    }
    // A failed pass must never leave an earlier cache entry valid.
    *snapshot = None;
    let mut pass = Pass::new(path, threshold)?;
    loop {
        let publication = files.file_lock(file, "append")?;
        let Some(end) = pass.current_end()? else {
            return Ok(MetricRetentionStats::default());
        };
        if end == pass.position {
            pass.publish()?;
            *snapshot = Some(Snapshot {
                stamp: Stamp::read(&pass.path)?,
                earliest: pass.earliest,
                threshold,
                kept: pass.stats.kept,
            });
            return Ok(pass.stats);
        }
        // EOF was captured between complete append calls; scan exactly that
        // prefix, allowing writers to append while it is being processed.
        drop(publication);
        pass.scan(end)?;
        pass.flush()?;
    }
}

struct Pass {
    path: PathBuf,
    // Close a failed output before its cleanup removes the temporary file.
    output: Option<BufWriter<File>>,
    temporary: TemporaryPath,
    source: Option<File>,
    position: u64,
    threshold: f64,
    earliest: f64,
    stats: MetricRetentionStats,
}

impl Pass {
    fn new(path: PathBuf, threshold: f64) -> io::Result<Self> {
        Ok(Self {
            source: Some(File::open(&path)?),
            temporary: TemporaryPath::new(temporary_path(&path)),
            path,
            output: None,
            position: 0,
            threshold,
            earliest: f64::INFINITY,
            stats: MetricRetentionStats::default(),
        })
    }

    fn source(&self) -> io::Result<&File> {
        self.source
            .as_ref()
            .ok_or_else(|| io::Error::other("retention source is closed"))
    }

    fn current_end(&self) -> io::Result<Option<u64>> {
        let source = self.source()?;
        let end = match butler_platform::secure_fs::current_metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if end < self.position || !butler_platform::secure_fs::same_open_file(source, &self.path)? {
            return Ok(None);
        }
        Ok(Some(end))
    }

    fn scan(&mut self, end: u64) -> io::Result<()> {
        let mut source = self.source()?.try_clone()?;
        source.seek(SeekFrom::Start(self.position))?;
        let mut reader = BufReader::new(source.take(end - self.position));
        let mut record = Vec::new();
        loop {
            record.clear();
            let bytes = reader.read_until(b'\n', &mut record)?;
            if bytes == 0 {
                break;
            }
            self.record(&record)?;
            self.position += bytes as u64;
        }
        if self.position != end {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "metric file shrank during retention",
            ));
        }
        Ok(())
    }

    fn record(&mut self, record: &[u8]) -> io::Result<()> {
        let blank = std::str::from_utf8(record).is_ok_and(|text| text.trim().is_empty());
        if blank {
            self.start_output()?;
            return Ok(());
        }
        self.stats.scanned += 1;
        let parsed = serde_json::from_slice::<Value>(record).ok();
        let timestamp = parsed
            .as_ref()
            .and_then(|value| value.get("ts"))
            .and_then(Value::as_f64)
            .filter(|timestamp| timestamp.is_finite());
        let (Some(mut value), Some(timestamp)) = (parsed, timestamp) else {
            self.stats.parse_errors += 1;
            self.start_output()?;
            return Ok(());
        };
        if timestamp < self.threshold {
            self.stats.deleted += 1;
            self.start_output()?;
            return Ok(());
        }
        self.earliest = self.earliest.min(timestamp);
        self.stats.kept += 1;
        if value.get("rawTextStored") != Some(&Value::Bool(false)) || !record.ends_with(b"\n") {
            self.start_output()?;
            value["rawTextStored"] = Value::Bool(false);
        }
        if let Some(output) = &mut self.output {
            serde_json::to_writer(&mut *output, &value).map_err(io::Error::other)?;
            output.write_all(b"\n")?;
        }
        Ok(())
    }

    fn start_output(&mut self) -> io::Result<()> {
        if self.output.is_none() {
            let output = open_private_temporary(&self.temporary.path)?;
            let mut writer = BufWriter::new(output);
            // Everything before the first edit is already valid and private.
            let mut prefix = File::open(&self.path)?.take(self.position);
            io::copy(&mut prefix, &mut writer)?;
            self.output = Some(writer);
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(writer) = &mut self.output {
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
        Ok(())
    }

    fn publish(&mut self) -> io::Result<()> {
        let Some(writer) = self.output.take() else {
            return Ok(());
        };
        drop(writer);
        drop(self.source.take());
        butler_platform::secure_fs::replace_file(&self.temporary.path, &self.path, &mut || Ok(()))?;
        butler_platform::secure_fs::sync_directory(self.path.parent().unwrap_or(Path::new(".")))
            .unwrap_or(Ok(()))?;
        self.temporary.commit();
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn assert_changed_live_file_aborts_without_publication() {
    for replace in [false, true] {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&root).unwrap();
        let path = root.join("events.jsonl");
        fs::write(&path, b"{\"ts\":1}\n").unwrap();
        let mut pass = Pass::new(path.clone(), 2.0).unwrap();
        let end = pass.current_end().unwrap().unwrap();
        pass.scan(end).unwrap();
        pass.flush().unwrap();
        let replacement = b"{\"ts\":3}\n";
        if replace {
            let staged = root.join("replacement");
            fs::write(&staged, replacement).unwrap();
            butler_platform::secure_fs::replace_file(&staged, &path, &mut || Ok(())).unwrap();
        } else {
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(0)
                .unwrap();
        }
        assert_eq!(pass.current_end().unwrap(), None);
        drop(pass);
        assert_eq!(
            fs::read(&path).unwrap(),
            if replace { replacement.as_slice() } else { b"" }
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
