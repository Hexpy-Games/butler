//! Display geometry is read by primary key on the database owner lane.
use super::super::AppStorageError;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};

pub(super) async fn execute(
    storage: super::super::AppStorage,
    mut value: Value,
) -> Result<Value, AppStorageError> {
    storage
        .read(move |db| {
            decorate(db, &mut value)?;
            Ok(value)
        })
        .await
}

pub(super) fn decorate(db: &Connection, value: &mut Value) -> Result<(), AppStorageError> {
    match value {
        Value::Array(items) => {
            for item in items {
                decorate(db, item)?;
            }
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                decorate(db, child)?;
            }
            if let Some(id) = object.get("img").and_then(Value::as_str).or_else(|| {
                let id = object.get("id")?.as_str()?;
                (object.get("url")?.as_str()? == format!("/message-assets/{id}")).then_some(id)
            }) {
                let size = db
                    .prepare_cached("SELECT width,height,pixel_ratio FROM app_assets WHERE id=?1")
                    .map_err(AppStorageError::sqlite)?
                    .query_row([id], |r| {
                        Ok((
                            r.get::<_, f64>(0)?,
                            r.get::<_, f64>(1)?,
                            r.get::<_, f64>(2)?,
                        ))
                    })
                    .optional()
                    .map_err(AppStorageError::sqlite)?;
                if let Some((width, height, ratio)) =
                    size.filter(|(w, h, r)| *w > 0.0 && *h > 0.0 && r.is_finite() && *r > 0.0)
                {
                    object.insert(
                        "image_width".into(),
                        json!((width / ratio).round().max(1.0)),
                    );
                    object.insert(
                        "image_height".into(),
                        json!((height / ratio).round().max(1.0)),
                    );
                }
            }
        }
        _ => {}
    }
    Ok(())
}
