//! Transcript activity kept per file: a transcript is scanned again only
//! from where it grew, and the scans of a cold cache run in parallel.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;

use super::{
    ActivityAccumulator, DELIVERY_FAILURE_WINDOW_MS, MAX_TOOL_KEYS, StatusTranscriptActivity,
    scan::scan_from,
};
use crate::context::status_conversation::TranscriptScanError;

/// Most scan threads of one refresh.
const MAX_SCAN_THREADS: usize = 8;

/// What one transcript contributed the last time it was scanned.
struct CachedFile {
    len: u64,
    modified: Option<SystemTime>,
    /// Offset just past the last complete line scanned.
    consumed: u64,
    activity: ActivityAccumulator,
}

/// A transcript file as listed: its length and modification time.
struct Listing {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

/// A transcript to scan, with what the cache already holds of it.
struct Job {
    listing: Listing,
    cached: Option<CachedFile>,
}

/// Activity of every transcript under `transcripts/`, refreshed per file.
#[derive(Default)]
pub(crate) struct TranscriptActivityCache {
    files: HashMap<PathBuf, CachedFile>,
}

impl TranscriptActivityCache {
    /// The activity of all transcripts as of `now_ms`.
    pub(crate) fn read(
        &mut self,
        data_root: &Path,
        now_ms: i64,
    ) -> Result<StatusTranscriptActivity, TranscriptScanError> {
        let listed = list_transcripts(&data_root.join("transcripts"))?;
        let present: HashSet<&Path> = listed
            .iter()
            .map(|listing| listing.path.as_path())
            .collect();
        self.files
            .retain(|path, _| present.contains(path.as_path()));
        self.refresh(listed)?;
        let mut total = ActivityAccumulator::default();
        for file in self.files.values() {
            total.absorb(&file.activity, now_ms);
        }
        total.prune(now_ms);
        Ok(total.summary)
    }

    /// [`Self::read`] at the current time.
    pub(crate) fn read_now(
        &mut self,
        data_root: &Path,
    ) -> Result<StatusTranscriptActivity, TranscriptScanError> {
        self.read(data_root, unix_now_ms())
    }

    /// The tool usage of one transcript file (`None` without such a file).
    pub(crate) fn read_file(
        &mut self,
        path: &Path,
    ) -> Result<Option<StatusTranscriptActivity>, TranscriptScanError> {
        let Some(listing) = file_listing(path)? else {
            self.files.remove(path);
            return Ok(None);
        };
        self.refresh(vec![listing])?;
        Ok(self.files.get(path).map(|file| {
            let mut alone = ActivityAccumulator::default();
            alone.absorb(&file.activity, unix_now_ms());
            alone.summary
        }))
    }

    fn refresh(&mut self, listed: Vec<Listing>) -> Result<(), TranscriptScanError> {
        let mut jobs = Vec::new();
        for listing in listed {
            if self
                .files
                .get(&listing.path)
                .is_some_and(|file| file.len == listing.len && file.modified == listing.modified)
            {
                continue;
            }
            let cached = self.files.remove(&listing.path);
            jobs.push(Job { listing, cached });
        }
        // The largest first, so the threads finish together.
        jobs.sort_by_key(|job| std::cmp::Reverse(job.listing.len));
        for (path, file) in scan_jobs(jobs)? {
            self.files.insert(path, file);
        }
        Ok(())
    }
}

/// Every `*.jsonl` file of the directory.
fn list_transcripts(directory: &Path) -> Result<Vec<Listing>, TranscriptScanError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(TranscriptScanError::Directory(error)),
    };
    let mut listed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(TranscriptScanError::Directory)?;
        if !entry.file_name().to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        if let Some(listing) = file_listing(&entry.path())? {
            listed.push(listing);
        }
    }
    Ok(listed)
}

/// A regular file as listed; `None` when it is gone or not a file.
fn file_listing(path: &Path) -> Result<Option<Listing>, TranscriptScanError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(Listing {
            path: path.to_path_buf(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(TranscriptScanError::Metadata(error)),
    }
}

/// Scans the jobs on up to [`MAX_SCAN_THREADS`] threads.
fn scan_jobs(jobs: Vec<Job>) -> Result<Vec<(PathBuf, CachedFile)>, TranscriptScanError> {
    let threads = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .min(MAX_SCAN_THREADS)
        .min(jobs.len());
    if threads <= 1 {
        return jobs.into_iter().map(scan_job).collect();
    }
    let jobs: Vec<Mutex<Option<Job>>> = jobs.into_iter().map(|job| Mutex::new(Some(job))).collect();
    let next = AtomicUsize::new(0);
    let done = Mutex::new(Vec::with_capacity(jobs.len()));
    let failure = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(job) = jobs.get(index).and_then(|slot| slot.lock().take()) else {
                        return;
                    };
                    match scan_job(job) {
                        Ok(scanned) => done.lock().push(scanned),
                        Err(error) => {
                            failure.lock().get_or_insert(error);
                        }
                    }
                }
            });
        }
    });
    match failure.into_inner() {
        Some(error) => Err(error),
        None => Ok(done.into_inner()),
    }
}

/// Scans a transcript from where it grew, or from the start when it was
/// replaced or shrank.
fn scan_job(job: Job) -> Result<(PathBuf, CachedFile), TranscriptScanError> {
    let Job { listing, cached } = job;
    let resumed = cached.filter(|cached| {
        listing.len >= cached.consumed
            && listing
                .modified
                .zip(cached.modified)
                .is_none_or(|(now, before)| now >= before)
    });
    let (mut consumed, mut activity) = resumed
        .map(|cached| (cached.consumed, cached.activity))
        .unwrap_or_default();
    consumed = scan_from(&listing.path, consumed, &mut activity)?;
    Ok((
        listing.path,
        CachedFile {
            len: listing.len,
            modified: listing.modified,
            consumed,
            activity,
        },
    ))
}

impl ActivityAccumulator {
    /// Adds what another transcript's scan found; failures older than the
    /// delivery window at `now_ms` are dropped.
    fn absorb(&mut self, other: &ActivityAccumulator, now_ms: i64) {
        let tools = &other.summary.tools;
        self.summary.tools.calls = self.summary.tools.calls.saturating_add(tools.calls);
        self.summary.tools.results = self.summary.tools.results.saturating_add(tools.results);
        self.summary.tools.successes = self.summary.tools.successes.saturating_add(tools.successes);
        self.summary.tools.failures = self.summary.tools.failures.saturating_add(tools.failures);
        for (name, bucket) in &other.summary.by_tool {
            let key = if self.summary.by_tool.contains_key(name)
                || self.summary.by_tool.len() < MAX_TOOL_KEYS
            {
                name.as_str()
            } else {
                "__other__"
            };
            let total = self.summary.by_tool.entry(key.to_owned()).or_default();
            total.calls = total.calls.saturating_add(bucket.calls);
            total.results = total.results.saturating_add(bucket.results);
            total.successes = total.successes.saturating_add(bucket.successes);
            total.failures = total.failures.saturating_add(bucket.failures);
        }
        self.delivery_unknown_count = self
            .delivery_unknown_count
            .saturating_add(other.delivery_unknown_count);
        if other.delivery_unknown_last_error.is_some() {
            self.delivery_unknown_last_error = other.delivery_unknown_last_error.clone();
        }
        self.delivery_overflow_count = self
            .delivery_overflow_count
            .saturating_add(other.delivery_overflow_count);
        self.delivery_overflow_latest_ms = self
            .delivery_overflow_latest_ms
            .max(other.delivery_overflow_latest_ms);
        let cutoff = now_ms.saturating_sub(DELIVERY_FAILURE_WINDOW_MS);
        for failure in other
            .delivery_failures
            .iter()
            .filter(|failure| failure.timestamp_ms >= cutoff)
        {
            self.insert_delivery_failure(failure.clone());
        }
    }
}

fn unix_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        })
}
