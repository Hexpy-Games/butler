//! Browser-decoded image sources: offline registered preview, both executors.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish, selected, setup};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};

#[tokio::test]
async fn image_collect_loaded_formats_and_session_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "explicit browser backend required");
    let setup = setup("BROWSER-IMAGE-SOURCES")?.env("PATH", std::env::var("PATH").unwrap());
    let cwd = setup.sandbox.workspace.clone();
    for (name, bytes) in [
        ("server.mjs", include_bytes!("images/server.mjs").as_slice()),
        (
            "photo.jpg",
            include_bytes!("../browser_outputs/pixel.jpg").as_slice(),
        ),
        ("photo.webp", include_bytes!("images/photo.webp").as_slice()),
        ("photo.avif", include_bytes!("images/photo.avif").as_slice()),
    ] {
        std::fs::write(cwd.join(name), bytes)?;
    }
    let s = setup.start().await?;
    let admin = admin(&s);
    let warm = open(&admin, "warmup", &publish(&s).await?).await?;
    assert_eq!(warm["status"], "ok", "{warm}");
    call(&admin, "warmup", "tab.close", &warm["tab"], json!({})).await?;
    let port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let started = call(&admin, "general", "preview.start", &Value::Null,
        json!({"agent":"images","preview_id":"images","command":format!("bun server.mjs {port}"),"cwd":cwd,"port":port})).await?;
    assert_eq!(started["browser"]["status"], "ok", "{started}");
    let tab = &started["browser"]["tab"];
    let page = call(
        &admin,
        "general",
        "tab.observe",
        tab,
        json!({"settle":true}),
    )
    .await?;
    for name in [
        "redirect",
        "lazy",
        "srcset",
        "background",
        "webp",
        "avif",
        "protected",
        "large",
        "svg",
        "covered",
    ] {
        let reference = page["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["name"] == name)
            .unwrap_or_else(|| panic!("missing {name}: {page}"));
        let image = call(
            &admin,
            "general",
            "tab.image_collect",
            tab,
            json!({"ref":reference["ref"],"observation":page["obs"]}),
        )
        .await?;
        assert_eq!(image["status"], "ok", "{name}: {image}");
        if name == "protected" {
            let url = reqwest::Url::parse(started["url"].as_str().unwrap())
                .unwrap()
                .join("/protected")
                .unwrap();
            let by_url = call(
                &admin,
                "general",
                "tab.image_collect",
                tab,
                json!({"url":url.as_str()}),
            )
            .await?;
            assert_eq!(by_url["status"], "ok", "loaded URL: {by_url}");
            assert_eq!(by_url["id"], image["id"], "URL keeps page pixels");
        }
        let bytes = s.gw.get(image["url"].as_str().unwrap()).await?;
        assert_eq!(bytes.status, 200);
        assert!(image["width"].as_u64().unwrap() > 0);
        assert!(image["height"].as_u64().unwrap() > 0);
        let response = reqwest::get(format!(
            "{}{}",
            s.gw.base,
            image["signed_url"].as_str().unwrap()
        ))
        .await?;
        assert_eq!(response.status(), 200);
        let bytes = response.bytes().await?;
        let decoded = butler_runtime::browser::normalize_image(&bytes).unwrap();
        assert_eq!(u64::from(decoded.width), image["width"].as_u64().unwrap());
        assert_eq!(u64::from(decoded.height), image["height"].as_u64().unwrap());
        if let Some(dir) = std::env::var_os("BUTLER_E2E_BROWSER_EVIDENCE") {
            let backend = std::env::var("BUTLER_E2E_BROWSER_BACKEND").unwrap();
            std::fs::write(
                std::path::Path::new(&dir).join(format!("{backend}-{name}.jpg")),
                bytes,
            )?;
        }
    }
    let empty = call(
        &admin,
        "general",
        "tab.image_collect",
        tab,
        json!({"url":""}),
    )
    .await?;
    assert_eq!(empty["status"], "refused", "{empty}");
    assert_eq!(empty["reason"], "invalid_image", "{empty}");
    call(
        &admin,
        "general",
        "preview.stop",
        &Value::Null,
        json!({"agent":"images","preview_id":"images"}),
    )
    .await?;
    s.finish().await
}
