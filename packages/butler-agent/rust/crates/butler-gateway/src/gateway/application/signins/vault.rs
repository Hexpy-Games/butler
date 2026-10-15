//! Payment cards, autofill profiles, their per-site fill allowances, the fill
//! audit and the purchase sites, in the App database. No secret is ever
//! stored here: numbers, CVCs and identity numbers live only in the OS
//! credential store; rows hold what the Settings list and the model may see.
mod records;
use super::{AppApplication, app_error};
use crate::gateway::ApplicationFuture;
use crate::gateway::application::AppStorageError;
use serde_json::Value;

/// A card's non-secret metadata, as saved.
#[derive(Clone, Debug)]
pub struct AppCardInput {
    pub nickname: String,
    pub brand: String,
    pub last4: String,
    pub exp_month: u32,
    pub exp_year: u32,
    pub holder_name: String,
    pub billing: Value,
    /// Which optional secrets are stored (`pin2`, `owner_id`).
    pub extras: Vec<String>,
}

/// A autofill profile's non-secret details, as saved.
#[derive(Clone, Debug)]
pub struct AppProfileInput {
    pub nickname: String,
    pub details: Value,
    /// Which secrets are stored (`birth_date`, `passport_number`, `rrn`).
    pub extras: Vec<String>,
}

/// Explicit vault commands over the App SQLite owner lane. `kind` is `card`
/// or `autofill`.
pub enum AppVaultCommand {
    /// Settings: cards, profiles (with allowed sites and recent uses) and purchase sites.
    List,
    /// One item's metadata.
    Item {
        kind: &'static str,
        id: String,
    },
    /// The model-visible list for a fill on a site.
    ForSite {
        site: String,
    },
    InsertCard(AppCardInput),
    UpdateCard {
        id: String,
        input: AppCardInput,
    },
    InsertProfile(AppProfileInput),
    UpdateProfile {
        id: String,
        input: AppProfileInput,
    },
    /// Removes the item and its site allowances (audit rows stay; they hold no values).
    Delete {
        kind: &'static str,
        id: String,
    },
    /// Allows (or stops allowing) fills of an item on a site without asking.
    SetSite {
        kind: &'static str,
        id: String,
        site: String,
        allow: bool,
    },
    /// Lets a purchase on a site go without the final approval card.
    PurchaseSite {
        site: String,
        allow: bool,
    },
    PurchaseAllowed {
        site: String,
    },
    Audit {
        kind: &'static str,
        item_id: String,
        session: String,
        turn: String,
        origin: String,
        frame_origin: String,
        result: String,
    },
}

impl AppApplication {
    pub(super) fn vault_owned(&self, command: AppVaultCommand) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        let now = self.dependencies.identity_clock.now_iso();
        let id = self.dependencies.identity_clock.new_uuid();
        Box::pin(async move {
            let read = matches!(
                command,
                AppVaultCommand::List
                    | AppVaultCommand::Item { .. }
                    | AppVaultCommand::ForSite { .. }
                    | AppVaultCommand::PurchaseAllowed { .. }
            );
            if read {
                this.storage
                    .read(move |db| records::read(db, command))
                    .await
                    .map_err(app_error)
            } else {
                this.storage
                    .execute(move |db| {
                        let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
                        let value = records::write(&tx, command, &now, &id)?;
                        tx.commit().map_err(AppStorageError::sqlite)?;
                        Ok(value)
                    })
                    .await
                    .map_err(app_error)
            }
        })
    }
}
