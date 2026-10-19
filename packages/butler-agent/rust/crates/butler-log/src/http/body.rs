//! Preserve transport size hints and frames while observing or replaying data.
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use std::{
    collections::VecDeque,
    pin::Pin,
    task::{Context, Poll},
};

pub(super) struct Observed {
    pub inner: reqwest::Body,
    pub attempt: Option<super::observe::Attempt>,
}
impl Body for Observed {
    type Data = Bytes;
    type Error = reqwest::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let next = Pin::new(&mut self.inner).poll_frame(cx);
        match &next {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref()
                    && let Some(attempt) = &mut self.attempt
                {
                    attempt.chunk(bytes);
                }
            }
            Poll::Ready(Some(Err(error))) => {
                if let Some(attempt) = &mut self.attempt {
                    attempt.read_error(error);
                }
                self.attempt.take();
            }
            Poll::Ready(None) => {
                if let Some(attempt) = &mut self.attempt {
                    attempt.complete();
                }
                self.attempt.take();
            }
            Poll::Pending => {}
        }
        next
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
}

pub(super) struct Replay {
    pub inner: reqwest::Body,
    pub prefix: VecDeque<Result<Frame<Bytes>, reqwest::Error>>,
}
impl Body for Replay {
    type Data = Bytes;
    type Error = reqwest::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        if let Some(frame) = self.prefix.pop_front() {
            return Poll::Ready(Some(frame));
        }
        Pin::new(&mut self.inner).poll_frame(cx)
    }
    fn size_hint(&self) -> SizeHint {
        let prefix: u64 = self
            .prefix
            .iter()
            .filter_map(|v| v.as_ref().ok()?.data_ref())
            .map(|b| b.len() as u64)
            .sum();
        let original = self.inner.size_hint();
        let mut hint = SizeHint::new();
        hint.set_lower(original.lower().saturating_add(prefix));
        if let Some(upper) = original.upper() {
            hint.set_upper(upper.saturating_add(prefix));
        }
        hint
    }
    fn is_end_stream(&self) -> bool {
        self.prefix.is_empty() && self.inner.is_end_stream()
    }
}
