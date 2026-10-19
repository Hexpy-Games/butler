//! Bounded summary text and change-driven trailing-edge publication.
use crate::btcc::AgentLoopProgress;
use std::time::Duration;
use tokio::time::Instant;

const INTERVAL: Duration = Duration::from_secs(1);
const TAIL_BYTES: usize = 16 * 1024;
#[derive(Default)]
pub(super) struct ThinkingLine {
    stream: Option<String>,
    round_id: String,
    tail: String,
    body: String,
    shown: Option<String>,
    summary_shown: String,
    summary_pending: bool,
    pending: Option<String>,
    last: Option<Instant>,
    summary_last: Option<Instant>,
    closed: bool,
}
impl ThinkingLine {
    pub(super) fn deadline(&self) -> Option<Instant> {
        let line = self.pending.as_ref().map(|_| due(self.last));
        let summary = self.summary_pending.then(|| due(self.summary_last));
        line.into_iter().chain(summary).min()
    }
    pub(super) async fn push(
        &mut self,
        round_id: String,
        stream: String,
        text: &str,
        progress: &dyn AgentLoopProgress,
    ) {
        if self.stream.as_ref() != Some(&stream) {
            self.clear(progress).await;
            *self = Self {
                stream: Some(stream),
                round_id,
                ..Self::default()
            };
        }
        if self.closed {
            return;
        }
        let mut end = text
            .len()
            .min((64 * 1024usize).saturating_sub(self.body.len()));
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.body.push_str(&text[..end]);
        if text.len() >= TAIL_BYTES {
            self.tail.clear();
        }
        let text = tail(text, TAIL_BYTES);
        let retained = tail(&self.tail, TAIL_BYTES - text.len()).len();
        self.tail.drain(..self.tail.len() - retained);
        self.tail.push_str(text);
        self.summary_pending = self.body != self.summary_shown;
        self.pending =
            derive(tail(&self.tail, 4096)).filter(|line| Some(line) != self.shown.as_ref());
        if self
            .deadline()
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            self.flush(progress).await;
        }
    }
    pub(super) async fn flush(&mut self, progress: &dyn AgentLoopProgress) {
        if let Some(stream) = &self.stream {
            let line_due = self.pending.is_some() && due(self.last) <= Instant::now();
            if !(line_due || self.summary_pending && due(self.summary_last) <= Instant::now()) {
                return;
            }
            if line_due {
                self.shown = self.pending.take();
                self.last = Some(Instant::now());
            }
            let _ = progress
                .model_thinking(
                    self.round_id.clone(),
                    stream.clone(),
                    self.shown.clone(),
                    Some(self.body.clone()),
                )
                .await;
            self.summary_shown.clone_from(&self.body);
            self.summary_pending = false;
            self.summary_last = Some(Instant::now());
        }
    }
    pub(super) async fn clear(&mut self, progress: &dyn AgentLoopProgress) {
        self.pending = None;
        self.tail.clear();
        self.body.clear();
        self.summary_pending = false;
        self.closed = true;
        if (self.shown.take().is_some() || !self.summary_shown.is_empty())
            && let Some(stream) = &self.stream
        {
            let _ = progress
                .model_thinking(self.round_id.clone(), stream.clone(), None, None)
                .await;
        }
        self.summary_shown.clear();
    }
}
fn due(last: Option<Instant>) -> Instant {
    last.map_or_else(Instant::now, |last| last + INTERVAL)
}
fn tail(text: &str, bytes: usize) -> &str {
    let mut start = text.len().saturating_sub(bytes);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}
use crate::btcc::thinking::derive;
