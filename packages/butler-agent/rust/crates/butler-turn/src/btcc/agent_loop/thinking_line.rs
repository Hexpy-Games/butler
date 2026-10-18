//! Bounded summary text and change-driven trailing-edge publication.
use crate::btcc::AgentLoopProgress;
use std::time::Duration;
use tokio::time::Instant;

const INTERVAL: Duration = Duration::from_secs(1);
const TAIL_BYTES: usize = 4096;
#[derive(Default)]
pub(super) struct ThinkingLine {
    stream: Option<String>,
    tail: String,
    shown: Option<String>,
    pending: Option<String>,
    last: Option<Instant>,
    closed: bool,
}
impl ThinkingLine {
    pub(super) fn deadline(&self) -> Option<Instant> {
        self.pending
            .as_ref()
            .map(|_| self.last.map_or_else(Instant::now, |last| last + INTERVAL))
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
        self.tail.push_str(text);
        if self.tail.len() > TAIL_BYTES {
            let mut start = self.tail.len() - TAIL_BYTES;
            while !self.tail.is_char_boundary(start) {
                start += 1;
            }
            self.tail.drain(..start);
        }
        self.pending = derive(&self.tail).filter(|line| Some(line) != self.shown.as_ref());
        if self
            .deadline()
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            self.flush(progress).await;
        }
    }
    pub(super) async fn flush(&mut self, progress: &dyn AgentLoopProgress) {
        if let (Some(stream), Some(line)) = (&self.stream, self.pending.take()) {
            let _ = progress
                .model_thinking(stream.clone(), Some(line.clone()))
                .await;
            self.shown = Some(line);
            self.last = Some(Instant::now());
        }
    }
    pub(super) async fn clear(&mut self, progress: &dyn AgentLoopProgress) {
        self.pending = None;
        self.tail.clear();
        self.closed = true;
        if self.shown.take().is_some()
            && let Some(stream) = &self.stream
        {
            let _ = progress.model_thinking(stream.clone(), None).await;
        }
    }
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

#[cfg(test)]
pub(super) mod tests {
    #![allow(clippy::unwrap_used, reason = "Pure-logic assertions")]
    use super::*;
    pub(crate) fn derives_latest_heading_complete_line_and_utf16_cap() {
        assert_eq!(
            derive("**First**\nbody\n## Latest heading\nbody"),
            Some("Latest heading".into())
        );
        assert_eq!(
            derive("\n- **A** [link](https://example.org)\npartial"),
            Some("A link".into())
        );
        assert_eq!(derive("unfinished"), None);
        assert_eq!(
            derive(&format!("**{}**", "😀".repeat(80)))
                .unwrap()
                .encode_utf16()
                .count(),
            120
        );
        assert_eq!(derive("**Hello   world**\n"), Some("Hello world".into()));
    }
    #[derive(Default)]
    struct Progress(std::sync::Mutex<Vec<Option<String>>>);
    impl AgentLoopProgress for Progress {
        fn emit(&self, _: crate::btcc::RuntimeTurnEventInput) -> crate::btcc::PortFuture<'_, ()> {
            panic!("thinking must never use durable progress")
        }
        fn model_thinking(
            &self,
            _: String,
            line: Option<String>,
        ) -> crate::btcc::PortFuture<'_, ()> {
            self.0.lock().unwrap().push(line);
            Box::pin(async { Ok(()) })
        }
    }
    pub(crate) async fn changed_line_waits_for_one_second_and_latest_wins() {
        let progress = Progress::default();
        let mut line = ThinkingLine::default();
        line.push("s".into(), "**First**\n", &progress).await;
        let deadline = line.last.unwrap() + INTERVAL;
        line.push("s".into(), "**Second**\n", &progress).await;
        line.push("s".into(), "**Latest**\n", &progress).await;
        assert_eq!(line.deadline(), Some(deadline));
        assert_eq!(*progress.0.lock().unwrap(), vec![Some("First".into())]);
        line.last = Some(Instant::now() - INTERVAL);
        line.push("s".into(), "body\n", &progress).await;
        assert_eq!(
            *progress.0.lock().unwrap(),
            vec![Some("First".into()), Some("Latest".into())]
        );
        line.push("s".into(), "body\n", &progress).await;
        assert_eq!(line.deadline(), None);
        line.clear(&progress).await;
        line.push("s".into(), "**Late**\n", &progress).await;
        assert_eq!(progress.0.lock().unwrap().last(), Some(&None));
        line.push("new".into(), "**Fresh**\n", &progress).await;
        assert_eq!(
            progress.0.lock().unwrap().last(),
            Some(&Some("Fresh".into()))
        );
        assert!(line.tail.len() <= TAIL_BYTES);
    }
}
