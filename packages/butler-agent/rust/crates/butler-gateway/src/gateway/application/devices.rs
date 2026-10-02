//! All credential writes use the App's single SQLite lane.
use super::{AppApplication, AppStorageError, app_error};
use crate::gateway::{ApplicationFuture, GatewayDevices, PairedDevice};

impl GatewayDevices for AppApplication {
    fn load_devices(&self) -> ApplicationFuture<Vec<PairedDevice>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(|db| {
                let mut query = db.prepare("SELECT id,secret_hash,name,ip,created_at,last_seen_at,revoked_at FROM paired_devices WHERE revoked_at IS NULL")
                    .map_err(AppStorageError::sqlite)?;
                query.query_map([], |row| Ok(PairedDevice {
                    id: row.get(0)?, secret_hash: row.get(1)?, name: row.get(2)?,
                    ip: row.get(3)?, created_at: row.get(4)?, last_seen_at: row.get(5)?,
                    revoked_at: row.get(6)?,
                })).map_err(AppStorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>().map_err(AppStorageError::sqlite)
            }).await.map_err(app_error)
        })
    }
    fn save_device(&self, device: PairedDevice) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(move |db| {
                db.execute("INSERT INTO paired_devices(id,secret_hash,name,ip,created_at,last_seen_at) VALUES(?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![device.id,device.secret_hash,device.name,device.ip,device.created_at,device.last_seen_at])
                    .map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)
        })
    }
    fn revoke_devices(&self, id: Option<String>, now: u64) -> ApplicationFuture<()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage.execute(move |db| {
                db.execute("UPDATE paired_devices SET revoked_at=?1 WHERE revoked_at IS NULL AND (?2 IS NULL OR id=?2)",
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
}
