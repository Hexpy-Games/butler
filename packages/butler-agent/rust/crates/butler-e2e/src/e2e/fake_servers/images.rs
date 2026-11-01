//! Deterministic image endpoints, independent of scripted chat replies.
#![allow(clippy::expect_used, reason = "synthetic E2E fixture assertions")]
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
#[derive(Clone)]
pub struct ImageRequest {
    pub path: String,
    pub json: Value,
    pub parts: Vec<(String, Vec<u8>)>,
}
#[derive(Default)]
struct ImageState {
    requests: Mutex<Vec<ImageRequest>>,
    error: Mutex<Option<(u16, String)>>,
    png: Vec<u8>,
    response: Mutex<Option<(Vec<u8>, bool)>>,
}
pub struct ImageServer {
    pub base: String,
    state: Arc<ImageState>,
    task: tokio::task::JoinHandle<()>,
}
impl ImageServer {
    pub async fn start() -> Result<Self, HarnessError> {
        let png = tokio::task::spawn_blocking(|| {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                128,
                128,
                image::Rgba([201, 202, 203, 204]),
            ))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("fixture PNG");
            bytes.into_inner()
        })
        .await
        .map_err(|e| super::super::harness_error(e.to_string()))?;
        let state = Arc::new(ImageState {
            png,
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let app = axum::Router::new()
            .fallback(image_reply)
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { base, state, task })
    }
    pub fn requests(&self) -> Vec<ImageRequest> {
        lock(&self.state.requests).clone()
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.state.png.clone()
    }
    pub fn respond(&self, bytes: Vec<u8>, truncated: bool) {
        *lock(&self.state.response) = Some((bytes, truncated));
    }
    pub fn fail(&self, status: u16, message: &str) {
        *lock(&self.state.error) = Some((status, message.into()));
    }
}
impl Drop for ImageServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn image_reply(
    axum::extract::State(state): axum::extract::State<Arc<ImageState>>,
    request: Request<Body>,
) -> Response<Body> {
    let path = request.uri().path().to_owned();
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 100 * 1024 * 1024)
        .await
        .expect("request body");
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let parts = content_type
        .split_once("boundary=")
        .map(|(_, b)| multipart(&bytes, b))
        .unwrap_or_default();
    lock(&state.requests).push(ImageRequest {
        path: path.clone(),
        json,
        parts,
    });
    if let Some((status, message)) = lock(&state.error).as_ref() {
        return json_response(*status, &json!({"error":{"message":message}}));
    }
    if let Some((bytes, truncated)) = lock(&state.response).clone() {
        let body = if truncated {
            let first = futures_util::stream::once(async move { Ok::<_, std::io::Error>(bytes) });
            let failure = futures_util::stream::once(async {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof))
            });
            Body::from_stream(futures_util::StreamExt::chain(first, failure))
        } else {
            Body::from(bytes)
        };
        return Response::builder()
            .header("content-type", "application/json")
            .body(body)
            .expect("fixture response");
    }
    let data = STANDARD.encode(&state.png);
    let body = if path.ends_with("interactions") {
        json!({"steps":[{"type":"model_output","content":[{"type":"text","text":"Ready"},{"type":"image","data":data}]}],"usage":{"total_input_tokens":30,"total_output_tokens":40,"input_tokens_by_modality":[{"modality":"text","tokens":10},{"modality":"image","tokens":20}],"output_tokens_by_modality":[{"modality":"image","tokens":40}]}})
    } else {
        json!({"data":[{"b64_json":data}],"usage":{"input_tokens":30,"input_tokens_details":{"text_tokens":10,"image_tokens":20},"output_tokens":40}})
    };
    json_response(200, &body)
}
fn multipart(bytes: &[u8], boundary: &str) -> Vec<(String, Vec<u8>)> {
    let delimiter = format!("--{boundary}");
    let starts = bytes
        .windows(delimiter.len())
        .enumerate()
        .filter(|(_, b)| *b == delimiter.as_bytes())
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    starts
        .windows(2)
        .filter_map(|pair| {
            let part = &bytes[pair[0] + delimiter.len() + 2..pair[1] - 2];
            let split = part.windows(4).position(|b| b == b"\r\n\r\n")?;
            let header = std::str::from_utf8(&part[..split]).ok()?;
            let name = header.split("name=\"").nth(1)?.split('"').next()?.into();
            Some((name, part[split + 4..].to_vec()))
        })
        .collect()
}
