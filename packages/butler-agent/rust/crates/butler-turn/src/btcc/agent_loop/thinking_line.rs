//! Bounded summary text and change-driven trailing-edge publication.
use crate::btcc::AgentLoopProgress;
use std::time::Duration;
use tokio::time::Instant;

const INTERVAL: Duration = Duration::from_secs(1);
const TAIL_BYTES: usize = 16 * 1024;
#[derive(Default)]
pub(super) struct ThinkingLine {
    stream: Option<String>,
    tail: String,
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
        stream: String,
        text: &str,
        progress: &dyn AgentLoopProgress,
    ) {
        if self.stream.as_ref() != Some(&stream) {
            self.clear(progress).await;
            *self = Self {
                stream: Some(stream),
                ..Self::default()
            };
        }
        if self.closed {
            return;
        }
        if text.len() >= TAIL_BYTES {
            self.tail.clear();
        }
        let text = tail(text, TAIL_BYTES);
        let retained = tail(&self.tail, TAIL_BYTES - text.len()).len();
        self.tail.drain(..self.tail.len() - retained);
        self.tail.push_str(text);
        self.summary_pending = self.tail != self.summary_shown;
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
                .model_thinking(stream.clone(), self.shown.clone(), Some(self.tail.clone()))
                .await;
            self.summary_shown.clone_from(&self.tail);
            self.summary_pending = false;
            self.summary_last = Some(Instant::now());
        }
    }
    pub(super) async fn clear(&mut self, progress: &dyn AgentLoopProgress) {
        self.pending = None;
        self.tail.clear();
        self.summary_pending = false;
        self.closed = true;
        if (self.shown.take().is_some() || !self.summary_shown.is_empty())
            && let Some(stream) = &self.stream
        {
            let _ = progress.model_thinking(stream.clone(), None, None).await;
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
fn heading(line: &str) -> Option<&str> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("**") {
        return rest.strip_suffix("**").filter(|rest| !rest.is_empty());
    }
    let rest = line.trim_start_matches('#');
    (rest.len() != line.len() && rest.starts_with(char::is_whitespace)).then_some(rest)
}
fn derive(tail: &str) -> Option<String> {
    let complete = tail.rsplit_once('\n').map_or("", |(complete, _)| complete);
    let line = tail
        .lines()
        .rev()
        .find_map(heading)
        .or_else(|| complete.lines().rev().find(|line| !line.trim().is_empty()))?;
    let plain = strip_markdown(line);
    let collapsed = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut units = 0;
    let capped: String = collapsed
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 120
        })
        .collect();
    (!capped.is_empty()).then_some(capped)
}
fn strip_markdown(line: &str) -> String {
    let mut plain = String::new();
    let mut chars = line
        .trim()
        .trim_start_matches(['#', '>', '-', '+'])
        .chars()
        .peekable();
    while let Some(c) = chars.next() {
        if matches!(c, '*' | '_' | '`' | '~' | '[' | ']') {
            continue;
        }
        if c == '(' && plain.ends_with(|c: char| !c.is_whitespace()) {
            let rest: String = chars.clone().collect();
            if rest.starts_with("http://") || rest.starts_with("https://") {
                for c in chars.by_ref() {
                    if c == ')' {
                        break;
                    }
                }
                continue;
            }
        }
        if c == '\\' {
            if let Some(next) = chars.next() {
                plain.push(next);
            }
        } else {
            plain.push(c);
        }
    }
    plain
}
