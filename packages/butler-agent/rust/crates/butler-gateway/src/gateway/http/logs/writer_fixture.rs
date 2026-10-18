//! Fault injection exists only in the fixture agent.
use super::*;
use std::sync::{Mutex, mpsc};

static RESUME: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

pub(crate) async fn route(uri: &Uri) -> Result<Response, HttpError> {
    let action = uri.path().rsplit('/').next().unwrap_or_default().to_owned();
    let log = butler_log::global().cloned().ok_or(HttpError::Internal)?;
    let result = blocking(move || {
        let mut resume = RESUME
            .lock()
            .map_err(|_| io::Error::other("fixture lock"))?;
        match action.as_str() {
            "pause" if resume.is_none() => *resume = Some(log.pause_writer()?),
            "resume" => {
                resume.take();
            }
            "fill" if resume.is_some() => {
                for size in [8192, 1] {
                    let dropped = log.queue_stats().2[2];
                    while log.queue_stats().2[2] == dropped {
                        log.record(butler_log::Record::new(
                            "INFO",
                            "turn",
                            "fill",
                            &"x".repeat(size),
                        ))?;
                    }
                }
            }
            "status" => {}
            _ => return Err(io::Error::other("invalid writer fixture action")),
        }
        Ok(value!({"write_timeouts":log.write_timeouts(), "dropped_info":log.queue_stats().2[2]}))
    })
    .await?;
    envelope(result)
}
