use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::contracts::LedgerEffectError;
use crate::locale::LocaleCollation;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LedgerHead {
    pub schema: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_authority: Option<String>,
    pub project_root: String,
    pub source_sha256: String,
    pub source_file_count: usize,
    pub storage_sha256: String,
    pub storage_entry_count: usize,
}

pub(super) fn observe(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<LedgerHead, LedgerEffectError> {
    let head = crate::project_ledger::source_head::observe(root, collation)
        .map_err(|_| LedgerEffectError::Uncertain)?;
    Ok(LedgerHead {
        schema: "butler.btcc-project-ledger-head.v1".into(),
        storage_authority: None,
        project_root: head.project_root.to_string_lossy().into_owned(),
        source_sha256: head.source_sha256,
        source_file_count: head.source_file_count,
        storage_sha256: head.storage_sha256,
        storage_entry_count: head.storage_entry_count,
    })
}

pub(super) fn inspect(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<LedgerHead, LedgerEffectError> {
    let mut head = observe(root, collation)?;
    head.schema = "project-ledger.source-head.v1".into();
    head.storage_authority = Some("project-ledger-authoritative-v2".into());
    Ok(head)
}

impl LedgerHead {
    pub(super) fn public(&self) -> Value {
        json!({
            "schema":self.schema,
            "sourceSha256":self.source_sha256,
            "sourceFileCount":self.source_file_count,
            "storageSha256":self.storage_sha256,
            "storageEntryCount":self.storage_entry_count,
        })
    }

    pub(super) fn same_logical(&self, other: &Self) -> bool {
        self.source_sha256 == other.source_sha256
            && self.source_file_count == other.source_file_count
    }

    pub(super) fn same_storage(&self, other: &Self) -> bool {
        self.same_logical(other)
            && self.storage_sha256 == other.storage_sha256
            && self.storage_entry_count == other.storage_entry_count
    }
}
