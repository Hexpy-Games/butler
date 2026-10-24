//! Header metadata survives upload, chat projection and repeated schema migration.
use super::*;
use image::{DynamicImage, ImageFormat};
use std::io::Cursor;

#[tokio::test]
async fn at_08_image_headers_and_unknown_sizes_persist_without_other_file_changes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("AT-08")?.start().await?;
    let project = project(&s).await?;
    let mut cases = Vec::new();
    for (name, mime, format) in [
        ("image.png", "image/png", ImageFormat::Png),
        ("image.jpg", "image/jpeg", ImageFormat::Jpeg),
        ("image.gif", "image/gif", ImageFormat::Gif),
        ("image.webp", "image/webp", ImageFormat::WebP),
    ] {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(31, 17)
            .write_to(&mut bytes, format)
            .map_err(|e| HarnessError(e.to_string()))?;
        cases.push((name, mime, bytes.into_inner(), json!([31, 17])));
    }
    // Extended and lossy WebP dimensions come from the same container header contract.
    for (tag, chunk) in [
        (b"VP8X", vec![0, 0, 0, 0, 30, 0, 0, 16, 0, 0]),
        (b"VP8 ", vec![0, 0, 0, 0x9d, 1, 0x2a, 31, 0, 17, 0]),
    ] {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&22u32.to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(tag);
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend(chunk);
        cases.push(("header.webp", "image/webp", bytes, json!([31, 17])));
    }
    cases.extend([
        (
            "note.txt",
            "text/plain",
            b"complete note".to_vec(),
            json!([null, null]),
        ),
        (
            "unknown.png",
            "image/png",
            b"unknown image".to_vec(),
            json!([null, null]),
        ),
        (
            "truncated.jpg",
            "image/jpeg",
            vec![0xff, 0xd8, 0xff, 0xc0, 0, 17, 8],
            json!([null, null]),
        ),
        (
            "zero.gif",
            "image/gif",
            b"GIF89a\0\0\0\0".to_vec(),
            json!([null, null]),
        ),
    ]);
    let mut expected = Vec::new();
    for (name, mime, bytes, size) in cases {
        let file =
            data(s.gw.upload(name, mime, &bytes, Some("general")).await?, 201)["file"].clone();
        assert_eq!(json!([file["width"], file["height"]]), size, "{name}");
        assert_eq!(file["safe_name"], name);
        assert_eq!(file["mime_type"], mime);
        assert_eq!(file["size_bytes"], bytes.len());
        assert_eq!(file["sha256"], butler_e2e::e2e::media::sha256(&bytes));
        assert_eq!(s.gw.download(file["url"].as_str().unwrap()).await?.1, bytes);
        let mut metadata = file;
        metadata.as_object_mut().unwrap().remove("signed_url");
        expected.push(metadata);
    }
    // The canon upload shares the same header/storage path.
    let png = butler_e2e::e2e::media::digits_png("1", 2);
    let canon = data(
        s.gw.upload_file(
            &format!("/projects/{project}/canon/files"),
            "capture.png",
            "image/png",
            &png,
        )
        .await?,
        201,
    )["file"]
        .clone();
    assert_eq!(json!([canon["width"], canon["height"]]), json!([20, 22]));
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('headers','general','user','Files','sent','now','now')", [])?;
    for (position, file) in expected.iter().enumerate() {
        db.execute(
            "INSERT INTO message_attachments(message_id,file_id,position) VALUES('headers',?1,?2)",
            rusqlite::params![file["file_id"].as_str(), position],
        )?;
    }
    drop(db);
    for _ in 0..2 {
        s.restart().await?;
        let messages = data(s.gw.get("/messages?chat_id=general").await?, 200);
        let message = messages["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "headers")
            .unwrap();
        let files = message["attachments"].as_array().unwrap();
        assert_eq!(files.len(), expected.len());
        for (file, expected) in files.iter().zip(&expected) {
            let mut metadata = file.clone();
            let signed = metadata
                .as_object_mut()
                .unwrap()
                .remove("signed_url")
                .unwrap();
            assert!(
                signed
                    .as_str()
                    .unwrap()
                    .starts_with(expected["url"].as_str().unwrap())
            );
            assert_eq!(&metadata, expected);
            let (status, bytes) = s.gw.download(signed.as_str().unwrap()).await?;
            assert_eq!(status, 200);
            assert_eq!(butler_e2e::e2e::media::sha256(&bytes), expected["sha256"]);
        }
    }
    s.finish().await
}

#[tokio::test]
async fn at_10_legacy_file_rows_gain_null_sizes_and_migration_is_idempotent()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("AT-10")?.start().await?;
    let mut file = data(
        s.gw.upload("legacy.txt", "text/plain", b"old notes", Some("general"))
            .await?,
        201,
    )["file"]
        .clone();
    file.as_object_mut().unwrap().remove("signed_url");
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch("ALTER TABLE message_files DROP COLUMN width; ALTER TABLE message_files DROP COLUMN height;
        INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('legacy-size','general','user','Notes','sent','now','now');")?;
    db.execute(
        "INSERT INTO message_attachments VALUES('legacy-size',?1,0)",
        [file["file_id"].as_str()],
    )?;
    drop(db);
    for _ in 0..2 {
        s.restart().await?;
        let messages = data(s.gw.get("/messages?chat_id=general").await?, 200);
        let message = messages["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "legacy-size")
            .unwrap();
        let mut loaded = message["attachments"][0].clone();
        loaded.as_object_mut().unwrap().remove("signed_url");
        assert!(loaded.get("width").unwrap().is_null());
        assert!(loaded.get("height").unwrap().is_null());
        assert_eq!(loaded, file);
        assert_eq!(
            s.gw.download(file["url"].as_str().unwrap()).await?.1,
            b"old notes"
        );
    }
    s.finish().await
}
