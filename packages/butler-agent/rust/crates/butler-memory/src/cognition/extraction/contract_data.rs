//! The bundled extraction contract (`contracts-v4.json`): instructions and
//! structured-output schemas of the meaning and binding stages.

use serde::Deserialize;
use serde_json::{Map, Value};
use std::sync::OnceLock;

#[derive(Deserialize)]
pub(super) struct ExtractionContractData {
    pub meaning_instructions: String,
    /// Passthrough: JSON Schema sent to the provider for the meaning stage.
    pub meaning_schema: Map<String, Value>,
    pub binding_instructions: String,
    /// Passthrough: JSON Schema sent to the provider for binding stages.
    pub binding_schema: Map<String, Value>,
}
impl ExtractionContractData {
    #[expect(
        clippy::expect_used,
        reason = "bundled generated contract; registration::tests::semantic::needs_context_records_one_bounded_input_recovery parses it"
    )]
    pub(super) fn get() -> &'static Self {
        static DATA: OnceLock<ExtractionContractData> = OnceLock::new();
        DATA.get_or_init(|| {
            serde_json::from_str(include_str!("contracts-v4.json"))
                .expect("generated extraction contract must parse")
        })
    }
}
