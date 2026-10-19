//! Raw-byte SSE limit, matching rmcp 3.4's MIT-licensed event limiter.
use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream::BoxStream};
use sse_stream::{Error as SseError, Sse, SseStream};
use std::{
    pin::Pin,
    task::{Poll, ready},
};
use thiserror::Error;
type BoxedSseResponse = BoxStream<'static, Result<Sse, SseError>>;
pub(super) fn bounded(response: reqwest::Response, limit: usize) -> BoxedSseResponse {
    bounded_sse_stream(response.bytes_stream(), limit)
}
#[derive(Debug, Error)]
enum BoundedSseStreamError {
    #[error(transparent)]
    Source(Box<dyn std::error::Error + Send + Sync>),
    #[error("SSE event exceeded the maximum size of {max_size} bytes")]
    EventTooLarge { max_size: usize },
}

#[derive(Debug)]
struct SseEventSizeLimiter {
    max_size: usize,
    retained_size: usize,
    line_size: usize,
    line_is_comment: bool,
    previous_was_cr: bool,
}

impl SseEventSizeLimiter {
    fn new(max_size: usize) -> Self {
        Self {
            max_size,
            retained_size: 0,
            line_size: 0,
            line_is_comment: false,
            previous_was_cr: false,
        }
    }

    fn observe(&mut self, chunk: &[u8]) -> Result<(), ()> {
        for &byte in chunk {
            if self.previous_was_cr {
                self.previous_was_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }

            match byte {
                b'\r' => {
                    self.finish_line()?;
                    self.previous_was_cr = true;
                }
                b'\n' => self.finish_line()?,
                _ => {
                    if self.line_size == 0 {
                        self.line_is_comment = byte == b':';
                    }
                    self.line_size = self.line_size.saturating_add(1);
                    self.check_limit()?;
                }
            }
        }
        Ok(())
    }

    fn finish_line(&mut self) -> Result<(), ()> {
        if self.line_size == 0 {
            self.retained_size = 0;
        } else if !self.line_is_comment {
            // The SSE parser inserts a newline when joining multiple data fields.
            self.retained_size = self
                .retained_size
                .saturating_add(self.line_size)
                .saturating_add(1);
        }
        self.line_size = 0;
        self.line_is_comment = false;
        self.check_limit()
    }

    fn check_limit(&self) -> Result<(), ()> {
        if self.retained_size.saturating_add(self.line_size) > self.max_size {
            Err(())
        } else {
            Ok(())
        }
    }
}

pin_project_lite::pin_project! {
    struct BoundedSseByteStream<S> {
        #[pin]
        inner: S,
        limiter: SseEventSizeLimiter,
        failed: bool,
    }
}

impl<S, E> Stream for BoundedSseByteStream<S>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    type Item = Result<Bytes, BoundedSseStreamError>;

    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let mut this = self.project();
        if *this.failed {
            return Poll::Ready(None);
        }

        match ready!(this.inner.as_mut().poll_next(cx)) {
            Some(Ok(chunk)) => {
                if this.limiter.observe(&chunk).is_err() {
                    *this.failed = true;
                    Poll::Ready(Some(Err(BoundedSseStreamError::EventTooLarge {
                        max_size: this.limiter.max_size,
                    })))
                } else {
                    Poll::Ready(Some(Ok(chunk)))
                }
            }
            Some(Err(error)) => {
                *this.failed = true;
                Poll::Ready(Some(Err(BoundedSseStreamError::Source(Box::new(error)))))
            }
            None => Poll::Ready(None),
        }
    }
}

fn bounded_sse_stream<S, E>(stream: S, max_event_size: usize) -> BoxedSseResponse
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let stream = BoundedSseByteStream {
        inner: stream,
        limiter: SseEventSizeLimiter::new(max_event_size),
        failed: false,
    };
    SseStream::from_bytes_stream(stream).boxed()
}
