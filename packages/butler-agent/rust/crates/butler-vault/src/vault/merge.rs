//! Merging two copies of a vault, item by item.

use super::format::{Item, Payload, Tombstone};
use std::collections::BTreeMap;

/// The newest version of every item from both copies: the newest `updated_at`
/// wins, the device id breaks a tie, and a deletion beats any edit not newer
/// than it. Items and tombstones do not depend on argument order. The vault id
/// and recipients stay `local`'s, so an import never adds a recipient.
pub fn merge(local: &Payload, incoming: &Payload) -> Payload {
    let mut newest = BTreeMap::<&str, &Item>::new();
    for item in local.items.iter().chain(&incoming.items) {
        newest
            .entry(&item.id)
            .and_modify(|held| {
                if version(item) > version(held) {
                    *held = item;
                }
            })
            .or_insert(item);
    }
    let mut deleted = BTreeMap::<&str, u64>::new();
    for tomb in local.tombstones.iter().chain(&incoming.tombstones) {
        deleted
            .entry(&tomb.id)
            .and_modify(|time| *time = tomb.deleted_at.max(*time))
            .or_insert(tomb.deleted_at);
    }
    // The item table and the tombstone table each keep what the other does
    // not beat, so an id is never in both.
    newest.retain(|id, item| deleted.get(id).is_none_or(|time| item.updated_at > *time));
    deleted.retain(|id, _| !newest.contains_key(id));
    Payload {
        format: local.format,
        vault_id: local.vault_id.clone(),
        seq: local.seq.max(incoming.seq),
        recipients: local.recipients.clone(),
        items: newest.into_values().cloned().collect(),
        tombstones: deleted
            .into_iter()
            .map(|(id, deleted_at)| Tombstone {
                id: id.to_owned(),
                deleted_at,
            })
            .collect(),
    }
}

fn version(item: &Item) -> (u64, &str, &str) {
    (item.updated_at, &item.device, item.value.expose())
}
