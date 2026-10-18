//! Count streamed uploads without buffering outside the explicit full preset.
use super::observe::full;
use parking_lot::Mutex;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
#[derive(Default)]
pub(super) struct Capture {
    bytes: AtomicU64,
    body: Mutex<super::capture::Capture>,
}
impl Capture {
    pub(super) fn attach(request: &mut reqwest::Request) -> Arc<Self> {
        use futures_util::TryStreamExt;
        use http_body_util::BodyExt;
        let capture = Arc::new(Self {
            body: Mutex::new(super::capture::Capture::new(request.headers())),
            ..Self::default()
        });
        let Some(body) = request.body_mut().take() else {
            return capture;
        };
        if let Some(bytes) = body.as_bytes() {
            capture.observe(bytes);
            *request.body_mut() = Some(body);
        } else {
            let observed = capture.clone();
            *request.body_mut() = Some(reqwest::Body::wrap_stream(
                body.into_data_stream()
                    .inspect_ok(move |bytes| observed.observe(bytes)),
            ));
        }
        capture
    }
    fn observe(&self, bytes: &[u8]) {
        self.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if full() {
            self.body.lock().observe(bytes);
        }
    }
    pub(super) fn retained_bytes(&self) -> usize {
        self.body.lock().retained_bytes()
    }
    pub(super) fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
    pub(super) fn body(&self, _headers: &reqwest::header::HeaderMap) -> serde_json::Value {
        self.body.lock().content()
    }
}
