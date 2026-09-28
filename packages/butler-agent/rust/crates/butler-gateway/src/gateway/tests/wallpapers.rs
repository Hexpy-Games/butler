use std::{net::SocketAddr, path::PathBuf, sync::atomic::AtomicU64};

use image::{ExtendedColorType, ImageEncoder, Rgba, RgbaImage, codecs::png::PngEncoder};
use serde_json::json;
use tokio::net::TcpListener;

use super::artifact_session::open_app_with_files;
use super::*;

const BOUNDARY: &str = "butler-wallpaper-boundary";

struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    fn error_code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap().to_owned()
    }
}

async fn call(
    address: SocketAddr,
    request_line: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Reply {
    let mut request = format!(
        "{request_line} HTTP/1.1\r\nhost: localhost:{}\r\nconnection: close\r\ncontent-length: {}\r\n",
        address.port(),
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let head = String::from_utf8(response[..split].to_vec()).unwrap();
    let status = head[9..12].parse().unwrap();
    Reply {
        status,
        head,
        body: response[split + 4..].to_vec(),
    }
}

async fn authorized(address: SocketAddr, request_line: &str, body: &[u8]) -> Reply {
    call(
        address,
        request_line,
        &[
            ("authorization", "Bearer secret"),
            ("content-type", "application/json"),
        ],
        body,
    )
    .await
}

async fn upload(
    address: SocketAddr,
    path: &str,
    filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> Reply {
    let mut body = format!(
        "--{BOUNDARY}\r\ncontent-disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
         content-type: {content_type}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let form = format!("multipart/form-data; boundary={BOUNDARY}");
    call(
        address,
        &format!("POST {path}"),
        &[("authorization", "Bearer secret"), ("content-type", &form)],
        &body,
    )
    .await
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = RgbaImage::from_pixel(width, height, Rgba([30, 90, 150, 255]));
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

struct Harness {
    server: GatewayServer,
    application: Arc<AppApplication>,
    files: Arc<AppMessageFiles>,
    data: PathBuf,
}

async fn start_harness() -> Harness {
    let data = std::env::temp_dir().join(format!("butler-wallpaper-http-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data).unwrap();
    let files = Arc::new(AppMessageFiles::new(
        &data,
        Arc::new(Clock(AtomicU64::new(1))),
    ));
    let application = Arc::new(open_app_with_files(&data, files.clone()).await);
    let gateway: Arc<dyn GatewayApplication> = application.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = GatewayConfig {
        local_auth: LocalAuthConfig::required(Some("secret".into())),
        ..GatewayConfig::default()
    };
    Harness {
        server: serve_gateway(listener, gateway, config).unwrap(),
        application,
        files,
        data,
    }
}

impl Harness {
    async fn close(self) {
        self.server.close().await.unwrap();
        self.application.close().await.unwrap();
        self.files.close().await.unwrap();
        std::fs::remove_dir_all(self.data).unwrap();
    }
}

struct Clock(AtomicU64);

impl AppIdentityClock for Clock {
    fn new_uuid(&self) -> String {
        let n = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("10000000-0000-4000-8000-{n:012x}")
    }
    fn now_iso(&self) -> String {
        "2026-09-28T00:00:00.000Z".into()
    }
    fn iso_after_millis(&self, _: u64) -> String {
        self.now_iso()
    }
}

/// Uploads a 1200x600 PNG declared as a JPEG; the declared name and type are
/// ignored, so it is stored from its content.
async fn upload_asset(address: SocketAddr) -> Value {
    let created = upload(
        address,
        "/wallpapers",
        "photo.jpg",
        "image/jpeg",
        &png(1200, 600),
    )
    .await;
    let body = String::from_utf8_lossy(&created.body);
    assert_eq!(created.status, 201, "{body}");
    created.json()["data"].clone()
}

fn failure(reply: &Reply) -> (u16, String) {
    (reply.status, reply.error_code())
}

#[tokio::test]
async fn wallpaper_routes_require_auth_and_reject_spoofed_or_oversized_uploads() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    for path in ["/wallpapers", "/wallpapers/wp_0123456789.png"] {
        let anonymous = call(address, &format!("GET {path}"), &[], &[]).await;
        assert_eq!(anonymous.status, 401, "{path}");
    }
    let html = b"<html>not a png</html>";
    let spoofed = upload(address, "/wallpapers", "photo.png", "image/png", html).await;
    assert_eq!(
        failure(&spoofed),
        (415, "wallpaper_unsupported_type".into())
    );
    let mut oversized = b"\xFF\xD8\xFF".to_vec();
    oversized.resize(25 * 1024 * 1024 + 1, 0);
    let oversized = upload(address, "/wallpapers", "big.jpg", "image/jpeg", &oversized).await;
    assert_eq!(failure(&oversized), (413, "wallpaper_too_large".into()));
    let empty = upload(address, "/wallpapers", "x", "text/plain", b"").await;
    assert_eq!(failure(&empty), (400, "wallpaper_image_invalid".into()));
    let listed = authorized(address, "GET /wallpapers", &[]).await;
    assert_eq!(listed.json()["data"]["wallpapers"], json!([]));
    harness.close().await;
}

#[tokio::test]
async fn uploaded_wallpaper_is_listed_and_served_with_cache_headers() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let asset = upload_asset(address).await;
    let id = asset["id"].as_str().unwrap().to_owned();
    let keys: Vec<_> = asset.as_object().unwrap().keys().collect();
    let expected = [
        "id",
        "width",
        "height",
        "luminance",
        "color",
        "bytes",
        "createdAt",
    ];
    assert_eq!(keys, expected);
    assert_eq!(
        (asset["width"].as_u64(), asset["height"].as_u64()),
        (Some(1200), Some(600))
    );
    assert_eq!(asset["color"], "#1e5a96");
    assert_eq!(asset["createdAt"], "2026-09-14T00:00:00.000Z");
    let listed = authorized(address, "GET /wallpapers", &[]).await;
    assert_eq!(listed.json()["data"]["wallpapers"], json!([asset]));

    let image = authorized(address, &format!("GET /wallpapers/{id}"), &[]).await;
    assert_eq!(image.status, 200);
    assert_eq!(image.header("content-type"), Some("image/jpeg"));
    let cache = Some("private, max-age=31536000, immutable");
    assert_eq!(image.header("cache-control"), cache);
    assert_eq!(image.header("etag"), Some(format!("\"{id}\"").as_str()));
    assert_eq!(image.body.len() as u64, asset["bytes"].as_u64().unwrap());
    assert!(image.body.starts_with(&[0xFF, 0xD8, 0xFF]));
    let thumbnail = authorized(address, &format!("GET /wallpapers/{id}/thumbnail"), &[]).await;
    assert_eq!(thumbnail.header("content-type"), Some("image/jpeg"));
    assert_eq!(thumbnail.header("cache-control"), cache);
    let decoded = image::load_from_memory(&thumbnail.body).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (480, 240));
    let unknown = authorized(address, "GET /wallpapers/wp_missing000/thumbnail", &[]).await;
    assert_eq!(failure(&unknown), (404, "wallpaper_not_found".into()));
    harness.close().await;
}

#[tokio::test]
async fn delete_route_refuses_a_wallpaper_the_setting_uses() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let id = upload_asset(address).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = json!({"wallpaper": {"source": {
        "kind": "image", "asset": id, "fit": "cover", "dim": 0.3, "blur": 0
    }}});
    let patched = authorized(address, "PATCH /settings", source.to_string().as_bytes()).await;
    assert_eq!(
        patched.status,
        200,
        "{}",
        String::from_utf8_lossy(&patched.body)
    );
    let refused = authorized(address, &format!("DELETE /wallpapers/{id}"), &[]).await;
    assert_eq!(failure(&refused), (409, "wallpaper_in_use".into()));

    let none = json!({"wallpaper": {"source": {"kind": "none"}}});
    let patched = authorized(address, "PATCH /settings", none.to_string().as_bytes()).await;
    assert_eq!(patched.status, 200);
    let deleted = authorized(address, &format!("DELETE /wallpapers/{id}"), &[]).await;
    assert_eq!(deleted.json()["data"], json!({"id": id, "deleted": true}));
    let gone = authorized(address, &format!("GET /wallpapers/{id}"), &[]).await;
    assert_eq!(failure(&gone), (404, "wallpaper_not_found".into()));
    harness.close().await;
}

#[tokio::test]
async fn internal_route_promotes_a_message_file_to_a_wallpaper() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let file = upload(
        address,
        "/message-files",
        "attached.png",
        "image/png",
        &png(640, 320),
    )
    .await;
    assert_eq!(file.status, 201, "{}", String::from_utf8_lossy(&file.body));
    let file_id = file.json()["data"]["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let body = json!({ "file_id": file_id }).to_string();
    let promoted = authorized(
        address,
        "POST /internal/wallpapers/from-message-file",
        body.as_bytes(),
    )
    .await;
    assert_eq!(
        promoted.status,
        201,
        "{}",
        String::from_utf8_lossy(&promoted.body)
    );
    let asset = promoted.json()["data"].clone();
    assert!(asset["id"].as_str().unwrap().starts_with("wp_"));
    assert_eq!(
        (asset["width"].as_u64(), asset["height"].as_u64()),
        (Some(640), Some(320))
    );
    let listed = authorized(address, "GET /wallpapers", &[]).await;
    assert_eq!(listed.json()["data"]["wallpapers"], json!([asset]));

    let invalid = authorized(
        address,
        "POST /internal/wallpapers/from-message-file",
        b"{}",
    )
    .await;
    assert_eq!(
        (invalid.status, invalid.error_code().as_str()),
        (400, "wallpaper_promotion_invalid")
    );
    let body = json!({ "file_id": "file-00000000-0000-4000-8000-00000000ffff" }).to_string();
    let unknown = authorized(
        address,
        "POST /internal/wallpapers/from-message-file",
        body.as_bytes(),
    )
    .await;
    assert_eq!(
        (unknown.status, unknown.error_code().as_str()),
        (404, "message_file_not_found")
    );
    harness.close().await;
}

#[tokio::test]
async fn project_preferences_route_sets_a_wallpaper_that_blocks_deletion() {
    let harness = start_harness().await;
    let address = harness.server.local_addr();
    let id = upload_asset(address).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let body = json!({"source": "scratch", "display_name": "Atlas"}).to_string();
    let created = authorized(address, "POST /projects", body.as_bytes()).await;
    assert_eq!(created.status, 201);
    let project = created.json()["data"]["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let patch = format!("PATCH /projects/{project}/dashboard/preferences");
    let image = json!({"kind": "image", "asset": id, "fit": "contain", "dim": 0.4, "blur": 0.1});
    let body = json!({"expectedRevision": 0, "wallpaper": image}).to_string();
    let patched = authorized(address, &patch, body.as_bytes()).await;
    let text = String::from_utf8_lossy(&patched.body);
    assert_eq!(patched.status, 200, "{text}");
    assert_eq!(patched.json()["data"], json!({"revision": 1}));
    let listed = authorized(address, "GET /projects", &[]).await;
    assert_eq!(listed.json()["data"]["projects"][0]["wallpaper"], image);
    let refused = authorized(address, &format!("DELETE /wallpapers/{id}"), &[]).await;
    assert_eq!(failure(&refused), (409, "wallpaper_in_use".into()));

    let body = json!({"expectedRevision": 1, "wallpaper": {"kind": "live"}}).to_string();
    let invalid = authorized(address, &patch, body.as_bytes()).await;
    assert_eq!(failure(&invalid), (400, "project_wallpaper_invalid".into()));
    let body = json!({"expectedRevision": 1, "wallpaper": "inherit"}).to_string();
    let patched = authorized(address, &patch, body.as_bytes()).await;
    assert_eq!(patched.status, 200);
    let deleted = authorized(address, &format!("DELETE /wallpapers/{id}"), &[]).await;
    assert_eq!(deleted.json()["data"], json!({"id": id, "deleted": true}));
    harness.close().await;
}

mod agent;
mod modules;
