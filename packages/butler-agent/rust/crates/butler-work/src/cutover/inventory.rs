//! Serializable observation input, independent of the Ledger and runtime ports.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Inventory {
    pub observations: Vec<Value>,
    pub needs_source: Vec<Value>,
    pub keys: BTreeMap<String, BTreeSet<String>>,
}

impl Inventory {
    /// Input order is observation order (including the last session head).
    pub fn hash(&self) -> serde_json::Result<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }

    pub fn load(db: &Connection) -> rusqlite::Result<Option<Self>> {
        let row: Option<(String, String)> = db
            .query_row(
                "SELECT inventory_hash,inventory_json FROM wm_cutover_inventory WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(hash, raw)| {
            let inventory: Self =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if inventory
                .hash()
                .map_err(|_| rusqlite::Error::InvalidQuery)?
                != hash
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(inventory)
        })
        .transpose()
    }

    pub(super) fn save(&self, db: &Connection) -> rusqlite::Result<()> {
        let raw = serde_json::to_string(self).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let hash = self.hash().map_err(|_| rusqlite::Error::InvalidQuery)?;
        db.execute("INSERT INTO wm_cutover_inventory VALUES(1,?1,?2) ON CONFLICT(singleton) DO UPDATE SET inventory_hash=excluded.inventory_hash,inventory_json=excluded.inventory_json", params![hash, raw])?;
        Ok(())
    }
}
