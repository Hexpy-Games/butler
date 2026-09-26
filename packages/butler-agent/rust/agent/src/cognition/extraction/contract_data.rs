use serde::Deserialize;
use serde_json::{Map, Value};
use std::sync::OnceLock;

#[derive(Deserialize)]
pub(super) struct ExtractionContractData {
    pub meaning_instructions: String,
    pub meaning_schema: Map<String, Value>,
    pub binding_instructions: String,
    pub binding_schema: Map<String, Value>,
}
impl ExtractionContractData {
    pub(super) fn get() -> &'static Self {
        static DATA: OnceLock<ExtractionContractData> = OnceLock::new();
        DATA.get_or_init(|| {
            serde_json::from_str(include_str!("contracts-v4.json"))
                .expect("generated extraction contract must parse")
        })
    }
}
