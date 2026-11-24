//! All credential writes use the App's single SQLite lane.
mod push;

use super::settings::persistence;
use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::{ApplicationFuture, DeviceKind, GatewayDevices, PairedDevice};

impl GatewayDevices for AppApplication {
    fn load_devices(&self) -> ApplicationFuture<Vec<PairedDevice>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(|db| {
                let mut query = db.prepare("SELECT id,secret_hash,name,ip,created_at,last_seen_at,revoked_at,kind FROM paired_devices WHERE revoked_at IS NULL")
                    .map_err(AppStorageError::sqlite)?;
                let devices = query.query_map([], |row| Ok((PairedDevice {
                    id: row.get(0)?, secret_hash: row.get(1)?, name: row.get(2)?,
                    ip: row.get(3)?, created_at: row.get(4)?, last_seen_at: row.get(5)?,
                    revoked_at: row.get(6)?, kind: DeviceKind::Browser,
                }, row.get::<_, String>(7)?))).map_err(AppStorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>().map_err(AppStorageError::sqlite)?;
                Ok(devices.into_iter().filter_map(|(device, kind)| {
                    DeviceKind::parse(&kind).map(|kind| PairedDevice { kind, ..device })
                }).collect())
            }).await.map_err(app_error)
        })
    }
    fn save_device(&self, device: PairedDevice) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(move |db| {
                db.execute("INSERT INTO paired_devices(id,secret_hash,name,ip,created_at,last_seen_at,kind) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![device.id,device.secret_hash,device.name,device.ip,device.created_at,device.last_seen_at,device.kind.as_str()])
                    .map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)
        })
    }
    fn set_device_push_token(&self, id: String, token: Option<String>) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(move |db| {
                if let Some(token) = &token {
                    db.execute("UPDATE paired_devices SET push_token=NULL WHERE push_token=?1 AND id<>?2",
                        rusqlite::params![token,id]).map_err(AppStorageError::sqlite)?;
                }
                db.execute("UPDATE paired_devices SET push_token=?1 WHERE id=?2 AND revoked_at IS NULL",
                    rusqlite::params![token,id]).map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)
        })
    }
    fn revoke_devices(&self, id: Option<String>, now: u64) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(move |db| {
                db.execute("UPDATE paired_devices SET revoked_at=?1, push_token=NULL WHERE revoked_at IS NULL AND (?2 IS NULL OR id=?2)",
                    rusqlite::params![now,id]).map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)
        })
    }
    fn touch_device(&self, id: String, now: u64) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(move |db| {
                db.execute("UPDATE paired_devices SET last_seen_at=MAX(last_seen_at,?1) WHERE id=?2 AND revoked_at IS NULL",
                    rusqlite::params![now,id]).map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)
        })
    }
    fn butler_id(&self) -> ApplicationFuture<String> {
        let storage = self.storage.clone();
        let now = self.dependencies.identity_clock.now_iso();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    if let Some(serde_json::Value::String(id)) =
                        persistence::read_json(db, "gateway.butler_id")?
                    {
                        return Ok(id);
                    }
                    let id = uuid::Uuid::new_v4().to_string();
                    persistence::write_json(
                        db,
                        "gateway.butler_id",
                        &serde_json::Value::String(id.clone()),
                        &now,
                    )?;
                    Ok(id)
                })
                .await
                .map_err(app_error)
        })
    }
}
