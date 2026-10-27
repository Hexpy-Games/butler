//! Cleanup follows registry commit and session stop; only key names leave this module.
use super::{Result, error};
use butler_platform::secrets::{SecretKey, SecretStore};
use serde_json::{Value, json};

pub(super) fn remove(keys: &[SecretKey], store: &Result<SecretStore>) -> Vec<Value> {
    keys.iter()
        .filter(|key| store.as_ref().ok().is_none_or(|s| s.delete(key).is_err()))
        .map(|key| json!({"key":key.account()}))
        .collect()
}
pub(super) fn system(keys: &[SecretKey]) -> Vec<Value> {
    if keys.is_empty() {
        return Vec::new();
    }
    remove(
        keys,
        &SecretStore::system().map_err(|_| error("connector_secret_store_unavailable")),
    )
}
pub(super) fn report(response: &mut Value, leftovers: &[Value]) {
    if !leftovers.is_empty() {
        response["code"] = "connector_secret_cleanup_pending".into();
        let mut record = butler_log::Record::new(
            "WARN",
            "plugins",
            "connector_secret_cleanup_pending",
            "Credential cleanup is pending",
        );
        record.attrs =
            json!({"keys":leftovers.iter().map(|item| &item["key"]).collect::<Vec<_>>()});
        butler_log::emit(record);
    }
    response["leftover_secrets"] = json!(leftovers);
}
