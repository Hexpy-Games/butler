use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::btcc::{BtccError, ToolJournalSignature};
use crate::json::{CanonicalKeyOrder, canonical_json, visit_raw_object};

#[derive(Default)]
pub(super) struct ResumePool {
    available: HashSet<String>,
    by_signature: HashMap<String, VecDeque<String>>,
}

impl ResumePool {
    pub(super) fn new(records: Vec<ToolJournalSignature>) -> Result<Self, BtccError> {
        let mut pool = Self::default();
        for record in records {
            let catalog_id = catalog_id(&record.raw_arguments)?;
            let signature = signature(&record.tool_name, &record.arguments, catalog_id.as_deref())?;
            pool.available.insert(record.call_id.clone());
            pool.by_signature
                .entry(signature)
                .or_default()
                .push_back(record.call_id);
        }
        Ok(pool)
    }

    pub(super) fn discard(&mut self, call_id: &str) {
        self.available.remove(call_id);
    }

    pub(super) fn claim(
        &mut self,
        name: &str,
        arguments: &Value,
        catalog_id: Option<&str>,
    ) -> Result<Option<String>, BtccError> {
        let key = signature(name, arguments, catalog_id)?;
        let Some(calls) = self.by_signature.get_mut(&key) else {
            return Ok(None);
        };
        while let Some(call_id) = calls.pop_front() {
            if self.available.remove(&call_id) {
                return Ok(Some(call_id));
            }
        }
        Ok(None)
    }
}

fn signature(name: &str, arguments: &Value, catalog_id: Option<&str>) -> Result<String, BtccError> {
    let body = canonical_json(arguments, CanonicalKeyOrder::Utf16Lexical)
        .map_err(|error| BtccError::relayed("guided_tool_identity_json", error.to_string()))?;
    Ok(format!("{}\0{name}\0{body}", catalog_id.unwrap_or("")))
}

fn catalog_id(raw: &str) -> Result<Option<String>, BtccError> {
    let mut id = None;
    visit_raw_object(raw, |key, value| {
        if key == "\"id\"" && value.starts_with('"') {
            id = serde_json::from_str::<String>(value).ok();
        }
        Ok(())
    })
    .map_err(|error| BtccError::relayed("guided_tool_identity_json", error.to_string()))?;
    Ok(id)
}
