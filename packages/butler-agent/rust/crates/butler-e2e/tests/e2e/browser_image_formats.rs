//! URL collection with an offline host transport: codec, store and signed JPEG delivery.
#![allow(clippy::unwrap_used, clippy::panic, reason = "E2E assertions")]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::json;

struct Host(tokio::task::JoinHandle<()>);
impl Drop for Host {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn url_images_avif_svg_external_refs_and_signed_delivery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("IMAGE-URL-FORMATS")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let tabs = json!({"tabs":[{"id":"formats","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":"https://images.example.test/"}]});
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(tabs),
                &[]
            )
            .await?
            .status,
        200
    );
    let host_admin = admin.clone();
    let host = Host(tokio::spawn(async move {
        let mut buffer = String::new();
        loop {
            let Ok(frame) = super::browser_delegation::next_frame(&mut stream, &mut buffer).await
            else {
                return;
            };
            if frame["op"] != "tab.image_collect" {
                continue;
            }
            let url = frame["args"]["url"].as_str().unwrap();
            let bytes: &[u8] = if url.ends_with(".avif") {
                include_bytes!("browser_headless/images/photo.avif")
            } else {
                include_bytes!("browser_headless/images/external.svg")
            };
            // Stub the upstream transfer, while the real gateway normalizes and stores its bytes.
            let result =
                json!({"status":"ok","source_url":url,"image":{"data":STANDARD.encode(bytes)}});
            let reply = host_admin
                .send(
                    Method::POST,
                    &format!(
                        "/internal/browser-host/results/{}",
                        frame["id"].as_str().unwrap()
                    ),
                    Some(result),
                    &[],
                )
                .await
                .unwrap();
            assert_eq!(reply.status, 200, "{}", reply.text);
        }
    }));
    for (name, dimensions) in [("photo.avif", None), ("external.svg", Some((1280, 960)))] {
        let source = format!("https://images.example.test/{name}");
        let reply = admin.send(Method::POST, "/internal/browser/calls",
            Some(json!({"op":"tab.image_collect","session":"general","tab":"formats","args":{"url":source}})), &[]).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let asset = reply.body;
        assert_eq!(asset["status"], "ok", "{asset}");
        let db = butler_platform::sqlite::open_with_flags(
            s.sandbox.data.join("app-server/butler-client.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let saved: String = db
            .query_row(
                "SELECT source_url FROM app_assets WHERE id=?1",
                [asset["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved, source);
        drop(db);
        let response = reqwest::get(format!(
            "{}{}",
            s.gw.base,
            asset["signed_url"].as_str().unwrap()
        ))
        .await?;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/jpeg");
        let bytes = response.bytes().await?;
        assert!(bytes.len() <= 250 * 1024);
        let image = image::load_from_memory(&bytes).unwrap();
        assert!(image.width().max(image.height()) <= 1280);
        assert_eq!(asset["width"], image.width());
        assert_eq!(asset["height"], image.height());
        if let Some((width, height)) = dimensions {
            assert_eq!((image.width(), image.height()), (width, height));
        }
    }
    drop(host);
    s.finish().await
}
