//! Real uploads retain independent identities across reuse, eviction and still replacement.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use butler_platform::secure_fs::{is_private, link_private, replace_private, same_file};
use reqwest::Method;
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf};

fn picture(color: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&image::RgbImage::from_pixel(2, 2, image::Rgb(color)))
        .unwrap();
    bytes
}

fn path(s: &Scenario, file: &Value) -> PathBuf {
    s.sandbox
        .data
        .join("app-server/message-files")
        .join(file["file_id"].as_str().unwrap())
}

async fn upload(s: &Scenario, bytes: &[u8]) -> Result<Value, HarnessError> {
    let reply =
        s.gw.upload("picture.jpg", "image/jpeg", bytes, Some("general"))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let file = reply.data()["file"].clone();
    assert_eq!(file["size_bytes"], bytes.len());
    Ok(file)
}

async fn download(s: &Scenario, file: &Value, bytes: &[u8]) -> Result<(), HarnessError> {
    let response =
        s.gw.http()
            .get(format!(
                "{}/message-files/{}",
                s.gw.base,
                file["file_id"].as_str().unwrap()
            ))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    assert!(
        response.bytes().await?.as_ref() == bytes,
        "complete uploaded bytes"
    );
    Ok(())
}

#[tokio::test]
async fn image_reuse_checks_complete_bytes_and_bounds_its_inventory() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("UPLOAD-CACHE")?.start().await?;
    let bytes = picture([200, 10, 20]);
    let first = upload(&s, &bytes).await?;
    let alias = upload(&s, &bytes).await?;
    assert_ne!(first["file_id"], alias["file_id"]);
    assert!(same_file(&path(&s, &first), &path(&s, &alias))?);
    assert_eq!(is_private(&path(&s, &alias)), Some(true));
    assert!(link_private(&path(&s, &first), &path(&s, &alias)).is_err());
    let changed = picture([10, 200, 20]);
    replace_private(
        &path(&s, &first),
        |file| file.write_all(&changed),
        |error| error,
    )?;
    download(&s, &first, &changed).await?;
    download(&s, &alias, &bytes).await?;
    let fresh = upload(&s, &bytes).await?;
    let mut tampered = bytes.clone();
    tampered[20] ^= 1;
    std::fs::write(path(&s, &fresh), &tampered)?;
    let repaired = upload(&s, &bytes).await?;
    download(&s, &repaired, &bytes).await?;
    std::fs::remove_file(path(&s, &repaired))?;
    let restored = upload(&s, &bytes).await?;
    download(&s, &restored, &bytes).await?;
    refuse_link_candidate(&s, &restored, &alias, &bytes).await?;
    assert_eviction(&s, &bytes).await?;
    download(&s, &alias, &bytes).await?;
    s.finish().await
}

async fn refuse_link_candidate(
    s: &Scenario,
    candidate: &Value,
    alias: &Value,
    bytes: &[u8],
) -> Result<(), HarnessError> {
    let target = path(s, candidate);
    std::fs::remove_file(&target)?;
    match butler_platform::secure_fs::symlink(&path(s, alias), &target) {
        Ok(()) => {
            let fresh = upload(s, bytes).await?;
            assert!(std::fs::symlink_metadata(path(s, &fresh))?.is_file());
            download(s, &fresh, bytes).await?;
        }
        // Some filesystems or security policies do not permit symlinks.
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
            ) =>
        {
            let fresh = upload(s, bytes).await?;
            download(s, &fresh, bytes).await?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

async fn assert_eviction(s: &Scenario, bytes: &[u8]) -> Result<(), HarnessError> {
    let before_items = upload(s, bytes).await?;
    for index in 0..300_u32 {
        let mut unique = bytes.to_vec();
        unique.extend(index.to_le_bytes());
        let file = upload(s, &unique).await?;
        download(s, &file, &unique).await?;
    }
    let after_items = upload(s, bytes).await?;
    assert!(
        !same_file(&path(s, &before_items), &path(s, &after_items))?,
        "item inventory evicts old candidates"
    );
    let mut large = bytes.to_vec();
    large.resize(9 * 1024 * 1024, 0);
    for index in 0..4 {
        *large.last_mut().unwrap() = index;
        let file = upload(s, &large).await?;
        download(s, &file, &large).await?;
    }
    let after_bytes = upload(s, bytes).await?;
    assert!(
        !same_file(&path(s, &after_items), &path(s, &after_bytes))?,
        "byte inventory evicts old candidates"
    );
    download(s, &before_items, bytes).await?;
    download(s, &after_items, bytes).await?;
    download(s, &after_bytes, bytes).await
}

#[tokio::test]
async fn mutable_browser_stills_detach_shared_uploads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("UPLOAD-STILL")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let tabs: Vec<_> = ["source", "aliases"].iter().map(|tab| json!({"id":tab,"owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":"https://example.com/"})).collect();
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser-host/events",
            Some(json!({"tabs":tabs})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    let original = picture([200, 10, 20]);
    let mut files = vec![still(&admin, "source", &original).await?];
    for _ in 1..200 {
        files.push(still(&admin, "aliases", &original).await?);
    }
    let ids: std::collections::HashSet<_> = files
        .iter()
        .map(|f| f["file_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 200);
    let outside = upload(&s, &original).await?;
    assert!(same_file(&path(&s, &files[0]), &path(&s, &outside))?);
    let changed_alias = picture([10, 200, 20]);
    let alias = still(&admin, "aliases", &changed_alias).await?;
    assert!(ids.contains(alias["file_id"].as_str().unwrap()));
    assert_ne!(alias["file_id"], files[0]["file_id"]);
    let changed_source = picture([10, 20, 200]);
    let source = still(&admin, "source", &changed_source).await?;
    assert_eq!(source["file_id"], files[0]["file_id"]);
    for file in files {
        let expected = if file["file_id"] == source["file_id"] {
            &changed_source
        } else if file["file_id"] == alias["file_id"] {
            &changed_alias
        } else {
            &original
        };
        download(&s, &file, expected).await?;
    }
    download(&s, &outside, &original).await?;
    let fresh = upload(&s, &original).await?;
    download(&s, &fresh, &original).await?;
    s.finish().await
}

async fn still(admin: &AdminClient, tab: &str, bytes: &[u8]) -> Result<Value, HarnessError> {
    let response = admin
        .send(
            Method::POST,
            "/internal/browser-host/stills",
            Some(json!({"session":"general","tab":tab,"still":{"base64":STANDARD.encode(bytes)}})),
            &[],
        )
        .await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let file = response.body["still_file"].clone();
    assert!(file["file_id"].is_string());
    Ok(file)
}
