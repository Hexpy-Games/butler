//! A shared atomic reservation prevents concurrent producers exceeding the byte budget.
use super::*;
pub(super) const NORMAL_BYTES: usize = 32 * 1024 * 1024;
pub(super) const ERROR_RESERVE: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub(super) struct Queue {
    pub bytes: AtomicUsize,
    pub notice: AtomicBool,
    pub dropped: [AtomicUsize; 3],
    #[cfg(feature = "e2e-fixtures")]
    pub peak: AtomicUsize,
}
impl Queue {
    pub(super) fn reserve(&self, bytes: usize, level: &str) -> bool {
        let limit = Self::limit(level);
        let mut current = self.bytes.load(Ordering::Relaxed);
        loop {
            let Some(next) = current.checked_add(bytes).filter(|next| *next <= limit) else {
                self.count_drop(level);
                return false;
            };
            match self.bytes.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    #[cfg(feature = "e2e-fixtures")]
                    self.peak.fetch_max(next, Ordering::Relaxed);
                    return true;
                }
                Err(actual) => current = actual,
            }
        }
    }
    fn limit(level: &str) -> usize {
        NORMAL_BYTES
            + if level.eq_ignore_ascii_case("ERROR") {
                ERROR_RESERVE
            } else {
                0
            }
    }
    fn count_drop(&self, level: &str) {
        let index = if level.eq_ignore_ascii_case("ERROR") {
            0
        } else if level.eq_ignore_ascii_case("WARN") {
            1
        } else {
            2
        };
        self.dropped[index].fetch_add(1, Ordering::Relaxed);
    }
    pub(super) fn reject_full(&self, level: &str) -> bool {
        if self.bytes.load(Ordering::Relaxed) < Self::limit(level) {
            return false;
        }
        self.count_drop(level);
        true
    }
}
impl Logger {
    pub(super) fn notify_queue_full(&self) -> io::Result<()> {
        if !self.0.queue.notice.swap(true, Ordering::Relaxed) {
            self.0.tx.send(Command::Dropped).map_err(io::Error::other)?;
        }
        Ok(())
    }

    pub(super) fn report_drops(&self) -> io::Result<()> {
        if self.0.queue.bytes.load(Ordering::Relaxed) != 0 {
            return Ok(());
        }
        self.0.queue.notice.store(false, Ordering::Relaxed);
        let counts = self
            .0
            .queue
            .dropped
            .each_ref()
            .map(|n| n.swap(0, Ordering::Relaxed));
        let total: usize = counts.iter().sum();
        if total > 0 {
            let mut row = Record::new(
                "WARN",
                "lifecycle",
                "logs.dropped",
                &format!("dropped {total} records (queue full)"),
            );
            row.attrs = serde_json::json!({"dropped":{"ERROR":counts[0],"WARN":counts[1],"INFO":counts[2]}});
            let config = self.config().effective;
            if let Err(error) =
                self.persist(super::super::encoded::Encoded::new(row, &config)?, &config)
            {
                for (counter, count) in self.0.queue.dropped.iter().zip(counts) {
                    counter.fetch_add(count, Ordering::Relaxed);
                }
                return Err(error);
            }
        }
        Ok(())
    }
    #[cfg(feature = "e2e-fixtures")]
    pub fn queue_stats(&self) -> (usize, usize, [usize; 3]) {
        let q = &self.0.queue;
        (
            q.bytes.load(Ordering::Relaxed),
            q.peak.load(Ordering::Relaxed),
            q.dropped.each_ref().map(|n| n.load(Ordering::Relaxed)),
        )
    }
    /// Dropping the sender resumes the writer, including when a test unwinds.
    #[cfg(feature = "e2e-fixtures")]
    pub fn pause_writer(&self) -> io::Result<mpsc::Sender<()>> {
        let (tx, rx) = mpsc::channel();
        self.request(|reply| Control::Pause(Mutex::new(rx), reply))?;
        Ok(tx)
    }
}
