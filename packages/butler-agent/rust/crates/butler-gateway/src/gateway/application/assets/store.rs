//! Blocking work runs only on App storage's database threads or spawn_blocking.
use super::super::{AppStorageError, storage::AppStorageCode};
use butler_platform::secure_fs;
use butler_runtime::browser::NormalizedImage;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) fn failed(error: impl std::fmt::Display) -> AppStorageError {
    AppStorageError::new(AppStorageCode::MessageFileNotFound, error.to_string())
}
pub(super) fn file(root: &Path, hash: &str, mime: &str) -> Result<PathBuf, AppStorageError> {
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(failed("invalid_asset_hash"));
    }
    Ok(root
        .join(&hash[..2])
        .join(format!("{hash}.{}", extension(mime)?)))
}
pub(super) fn asset_id(digest: &[u8], length: usize) -> String {
    let mut number = digest.to_vec();
    let mut digits = Vec::new();
    while number.iter().any(|b| *b != 0) {
        let mut remainder = 0_u16;
        for byte in &mut number {
            let value = remainder * 256 + u16::from(*byte);
            *byte = u8::try_from(value / 36).unwrap_or(0);
            remainder = value % 36;
        }
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[usize::from(remainder)]);
    }
    // Fixed width makes the 12-character collision id extend the same 10-character prefix.
    digits.resize(50, b'0');
    digits.reverse();
    format!("img_{}", String::from_utf8_lossy(&digits[..length]))
}

pub(super) fn collect(
    db: &mut Connection,
    root: &Path,
    session: &str,
    image: &NormalizedImage,
    alt: &str,
    nearby: &str,
    url: &str,
) -> Result<Value, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let exists = tx
        .query_row("SELECT 1 FROM chats WHERE id=?1", [session], |_| Ok(()))
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if exists.is_none() {
        return Err(failed("unknown_chat"));
    }
    let id = insert_collected(&tx, root, image, alt, url)?;
    let bound = tx
        .query_row(
            "SELECT 1 FROM app_asset_refs WHERE asset_id=?1 AND owner_kind='chat' AND owner_id=?2",
            params![id, session],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if bound.is_none() {
        tx.execute(
            "INSERT INTO app_asset_refs VALUES(?1,'chat',?2)",
            params![id, session],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(
        json!({"status":"ok","id":id,"width":image.width,"height":image.height,"alt":alt,"nearby_text":nearby,"url":format!("/message-assets/{id}")}),
    )
}

fn insert_collected(
    db: &Connection,
    root: &Path,
    image: &NormalizedImage,
    alt: &str,
    url: &str,
) -> Result<String, AppStorageError> {
    let hash = format!("{:x}", Sha256::digest(&image.bytes));
    let mut identity = Sha256::new();
    identity.update(&image.bytes);
    identity.update(image.pixel_ratio.to_le_bytes());
    let digest = identity.finalize();
    let existing = db
        .query_row(
            "SELECT id FROM app_assets WHERE sha256=?1 AND pixel_ratio=?2",
            params![hash, image.pixel_ratio],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let id = if let Some(id) = existing {
        id
    } else {
        let mut id = asset_id(&digest, 10);
        if db
            .query_row("SELECT 1 FROM app_assets WHERE id=?1", [&id], |_| Ok(()))
            .optional()
            .map_err(AppStorageError::sqlite)?
            .is_some()
        {
            id = asset_id(&digest, 12);
        }
        let target = file(root, &hash, "image/jpeg")?;
        secure_fs::create_private_dir_all(
            target
                .parent()
                .ok_or_else(|| failed("invalid_asset_path"))?,
        )
        .map_err(failed)?;
        secure_fs::replace_private(&target, |f| f.write_all(&image.bytes), |e| e)
            .map_err(failed)?;
        db.execute("INSERT INTO app_assets(id,sha256,mime,width,height,bytes,alt,source_url,pixel_ratio,created_at) VALUES(?1,?2,'image/jpeg',?3,?4,?5,?6,?7,?8,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![id,hash,image.width,image.height,image.bytes.len(),alt,url,image.pixel_ratio]).map_err(AppStorageError::sqlite)?;
        id
    };
    Ok(id)
}

pub(super) fn lookup(db: &Connection, ids: &[String]) -> Result<Value, AppStorageError> {
    let mut query = db
        .prepare_cached("SELECT id FROM app_assets WHERE id=?1")
        .map_err(AppStorageError::sqlite)?;
    let mut found = Vec::new();
    for id in ids {
        if query
            .query_row([id], |r| r.get::<_, String>(0))
            .optional()
            .map_err(AppStorageError::sqlite)?
            .is_some()
        {
            found.push(id.clone());
        }
    }
    Ok(json!({"ids":found}))
}
pub(super) fn identity(db: &Connection, id: &str) -> Result<(String, String), AppStorageError> {
    db.query_row(
        "SELECT sha256,mime FROM app_assets WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(AppStorageError::sqlite)?
    .ok_or_else(|| failed("asset_not_found"))
}
pub(super) fn read(root: &Path, hash: &str, mime: &str) -> Result<Vec<u8>, AppStorageError> {
    let mut bytes = Vec::new();
    secure_fs::open_read_no_follow(&file(root, hash, mime)?)
        .map_err(failed)?
        .read_to_end(&mut bytes)
        .map_err(failed)?;
    Ok(bytes)
}
pub(super) fn resize(bytes: Vec<u8>, width: Option<u32>) -> Result<Vec<u8>, AppStorageError> {
    let Some(width) = width else {
        return Ok(bytes);
    };
    let image = image::load_from_memory(&bytes).map_err(failed)?;
    if width >= image.width() {
        return Ok(bytes);
    }
    let height = u32::try_from(
        (u64::from(image.height()) * u64::from(width) / u64::from(image.width())).max(1),
    )
    .map_err(failed)?;
    let image = image.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
    if image.color().has_alpha() {
        let mut output = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(failed)?;
        return Ok(output.into_inner());
    }
    let image = image.to_rgb8();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 75)
        .encode_image(&image)
        .map_err(failed)?;
    Ok(bytes)
}
pub(super) fn sweep(db: &Connection, root: &Path) -> Result<(), AppStorageError> {
    let mut query = db
        .prepare("SELECT sha256 FROM app_asset_sweep")
        .map_err(AppStorageError::sqlite)?;
    let hashes = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    for hash in hashes {
        let live = db
            .query_row("SELECT 1 FROM app_assets WHERE sha256=?1", [&hash], |_| {
                Ok(())
            })
            .optional()
            .map_err(AppStorageError::sqlite)?
            .is_some();
        if !live {
            for mime in ["image/jpeg", "image/png", "image/webp"] {
                if let Err(error) = std::fs::remove_file(file(root, &hash, mime)?)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    return Err(failed(error));
                }
            }
        }
        db.execute("DELETE FROM app_asset_sweep WHERE sha256=?1", [&hash])
            .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

pub(super) fn extension(mime: &str) -> Result<&'static str, AppStorageError> {
    match mime {
        "image/jpeg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        _ => Err(failed("invalid_asset_mime")),
    }
}
