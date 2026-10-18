//! Request completion waits for its own batch's writes, with bounded async waiting.
use super::*;
use std::time::Duration;

impl Logger {
    /// Wait for file visibility, without making the response depend on fsync.
    pub async fn record_written(&self, row: Record) -> io::Result<()> {
        let (tx, rx) = oneshot::channel();
        if !self.enqueue(row, Some(tx))? {
            return Ok(());
        }
        match tokio::time::timeout(Duration::from_millis(250), rx).await {
            Ok(reply) => reply.map_err(io::Error::other)?,
            Err(_) => {
                self.0.write_timeouts.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
        }
    }

    pub fn write_timeouts(&self) -> usize {
        self.0.write_timeouts.load(Ordering::Relaxed)
    }
}
