//! Drive the production chunk observer without network scheduling in E2E measurements.
use super::{Phase, Purpose, observe::Attempt};

pub fn observe_sse_chunks(
    chunk: &[u8],
    count: usize,
) -> Result<serde_json::Value, url::ParseError> {
    let mut request =
        reqwest::Request::new(reqwest::Method::GET, url::Url::parse("http://localhost/")?);
    let mut attempt = Attempt::new(&mut request, &Purpose::new("stream"), &Phase::default());
    attempt.sse = true;
    for _ in 0..count {
        attempt.chunk(std::hint::black_box(chunk));
    }
    Ok(
        serde_json::json!({"bytes": attempt.bytes, "chunks": attempt.chunks,
        "finish_reason": attempt.row.attrs["finish_reason"]}),
    )
}
