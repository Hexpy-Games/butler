use std::{
    pin::Pin,
    task::{Context, Poll},
};

use axum::body::{Body, Bytes};
use futures_core::Stream;

use super::*;

#[tokio::test]
async fn body_read_errors_distinguish_size_limit_from_body_source_failure() {
    let limit_error = http::read_body_with_limit(Body::from("ab"), 1)
        .await
        .unwrap_err();
    assert!(matches!(limit_error, http::HttpError::PayloadTooLarge));

    let source_error = http::read_body_with_limit(Body::from_stream(FailingBodyStream), 1)
        .await
        .unwrap_err();
    assert!(matches!(
        source_error,
        http::HttpError::Public { ref code, .. } if code == "invalid_json"
    ));
}

struct FailingBodyStream;

impl Stream for FailingBodyStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(Some(Err(std::io::Error::other("controlled body failure"))))
    }
}
