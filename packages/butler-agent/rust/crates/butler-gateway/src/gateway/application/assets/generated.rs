//! Lossless validation before storage; indexed lineage queries on storage lanes.
use super::super::{AppStorageError, storage::AppStorageCode};
use super::store::{asset_id, failed, file};
use butler_platform::secure_fs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    path::Path,
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeneratedAssetKind {
    Original,
    Generated,
    Mask,
}
impl GeneratedAssetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Generated => "generated",
            Self::Mask => "mask",
        }
    }
}
pub(super) struct ValidatedImage {
    bytes: Vec<u8>,
    mime: &'static str,
    width: u32,
    height: u32,
    alpha: bool,
}
impl ValidatedImage {
    pub(super) fn valid_mask(&self, meta: &Value) -> bool {
        self.mime == "image/png"
            && self.alpha
            && meta["width"].as_u64() == Some(u64::from(self.width))
            && meta["height"].as_u64() == Some(u64::from(self.height))
    }
}
pub(super) fn validate(bytes: Vec<u8>) -> Result<ValidatedImage, &'static str> {
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("image_asset_too_large");
    }
    let format = image::guess_format(&bytes).map_err(|_| "image_asset_format_invalid")?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("image_asset_format_invalid"),
    };
    let reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
    let decoder = reader.into_decoder().map_err(|_| "image_asset_invalid")?;
    use image::ImageDecoder;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("image_asset_dimensions_invalid");
    }
    let alpha = decoder.color_type().has_alpha();
    drop(decoder);
    Ok(ValidatedImage {
        bytes,
        mime,
        width,
        height,
        alpha,
    })
}

pub(super) fn put_generated(
    db: &mut Connection,
    root: &Path,
    session: &str,
    image: &ValidatedImage,
    kind: GeneratedAssetKind,
    parent_id: Option<String>,
    model_ref: Option<&str>,
) -> Result<Value, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    tx.query_row("SELECT 1 FROM chats WHERE id=?1", [session], |_| Ok(()))
        .map_err(AppStorageError::sqlite)?;
    validate_parent(&tx, image, kind, parent_id.as_deref())?;
    let digest = Sha256::digest(&image.bytes);
    let hash = format!("{digest:x}");
    let existing: Option<(String, String, Option<String>)> = tx
        .query_row(
            "SELECT id,kind,parent_id FROM app_assets WHERE sha256=?1 AND kind=?2 AND parent_id IS ?3",
            params![hash, kind.as_str(), parent_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let existing = existing.filter(|_| kind != GeneratedAssetKind::Generated);
    let id = if let Some((id, stored_kind, parent)) = existing {
        if stored_kind != kind.as_str() || parent != parent_id {
            return Err(failed("image_asset_lineage_conflict"));
        }
        id
    } else {
        let mut id = if kind == GeneratedAssetKind::Generated {
            let occurrence = Sha256::digest(uuid::Uuid::new_v4().as_bytes());
            asset_id(&occurrence, 12)
        } else {
            asset_id(&digest, 10)
        };
        if tx
            .query_row("SELECT 1 FROM app_assets WHERE id=?1", [&id], |_| Ok(()))
            .optional()
            .map_err(AppStorageError::sqlite)?
            .is_some()
        {
            id = asset_id(&digest, 12);
        }
        write_blob(&tx, root, &hash, image)?;
        tx.execute("INSERT INTO app_assets(id,sha256,mime,width,height,bytes,alt,source_url,created_at,kind,parent_id,model_ref,pixel_ratio) VALUES(?1,?2,?3,?4,?5,?6,'','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),?7,?8,?9,1)", params![id,hash,image.mime,image.width,image.height,image.bytes.len(),kind.as_str(),parent_id,model_ref]).map_err(AppStorageError::sqlite)?;
        if let Some(parent) = parent_id {
            tx.execute(
                "INSERT INTO app_asset_refs VALUES(?1,'asset',?2)",
                params![parent, id],
            )
            .map_err(AppStorageError::sqlite)?;
        }
        id
    };
    tx.execute(
        "INSERT OR IGNORE INTO app_asset_refs VALUES(?1,'chat',?2)",
        params![id, session],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    Ok(json!({"id":id,"width":image.width,"height":image.height}))
}

pub(super) fn meta(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    db.query_row("SELECT id,kind,mime,width,height,bytes,parent_id,model_ref,created_at FROM app_assets WHERE id=?1", [id], |r| Ok(json!({
        "id":r.get::<_,String>(0)?,"img":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"mime":r.get::<_,String>(2)?,
        "width":r.get::<_,u32>(3)?,"height":r.get::<_,u32>(4)?,"bytes":r.get::<_,u64>(5)?,
        "parent_id":r.get::<_,Option<String>>(6)?,"model_ref":r.get::<_,Option<String>>(7)?,"created_at":r.get::<_,String>(8)?
    }))).optional().map_err(AppStorageError::sqlite)?.ok_or_else(|| failed("asset_not_found"))
}
pub(super) fn versions(db: &Connection, id: &str) -> Result<Value, AppStorageError> {
    let mut query = db.prepare_cached("WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM app_assets WHERE id=?1 UNION ALL
      SELECT a.id,a.parent_id FROM app_assets a JOIN ancestors p ON a.id=p.parent_id),
      lineage(id) AS (SELECT id FROM ancestors WHERE parent_id IS NULL UNION ALL
      SELECT a.id FROM app_assets a JOIN lineage p ON a.parent_id=p.id)
      SELECT a.id,a.parent_id,a.width,a.height,a.created_at FROM lineage l JOIN app_assets a ON a.id=l.id
      WHERE a.kind!='mask' ORDER BY a.created_at,a.rowid").map_err(AppStorageError::sqlite)?;
    let rows = query
        .query_map([id], |r| {
            Ok(
                json!({"id":r.get::<_,String>(0)?,"img":r.get::<_,String>(0)?,"parent_id":r.get::<_,Option<String>>(1)?,
        "width":r.get::<_,u32>(2)?,"height":r.get::<_,u32>(3)?,"created_at":r.get::<_,String>(4)?}),
            )
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    Ok(json!(rows))
}

fn validate_parent(
    db: &Connection,
    image: &ValidatedImage,
    kind: GeneratedAssetKind,
    parent_id: Option<&str>,
) -> Result<(), AppStorageError> {
    if let Some(parent) = parent_id {
        let (width, height): (u32, u32) = db
            .query_row(
                "SELECT width,height FROM app_assets WHERE id=?1",
                [parent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(AppStorageError::sqlite)?;
        if kind == GeneratedAssetKind::Mask
            && (image.mime != "image/png"
                || !image.alpha
                || (width, height) != (image.width, image.height))
        {
            return Err(AppStorageError::new(
                AppStorageCode::MessageFileNotFound,
                "image_mask_invalid",
            ));
        }
    } else if kind == GeneratedAssetKind::Mask {
        return Err(failed("image_mask_parent_required"));
    }
    Ok(())
}

fn write_blob(
    db: &Connection,
    root: &Path,
    hash: &str,
    image: &ValidatedImage,
) -> Result<(), AppStorageError> {
    let present = db
        .query_row("SELECT 1 FROM app_assets WHERE sha256=?1", [hash], |_| {
            Ok(())
        })
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if present {
        return Ok(());
    }
    let path = file(root, hash, image.mime)?;
    secure_fs::create_private_dir_all(path.parent().ok_or_else(|| failed("invalid_asset_path"))?)
        .map_err(failed)?;
    secure_fs::replace_private(&path, |f| f.write_all(&image.bytes), |e| e).map_err(failed)?;
    Ok(())
}
