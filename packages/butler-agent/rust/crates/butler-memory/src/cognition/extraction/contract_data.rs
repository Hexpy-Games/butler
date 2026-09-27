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
    #[expect(
        clippy::expect_used,
        reason = "bundled generated contract; tests::bundled_contract_parses parses it"
    )]
    pub(super) fn get() -> &'static Self {
        static DATA: OnceLock<ExtractionContractData> = OnceLock::new();
        DATA.get_or_init(|| {
            serde_json::from_str(include_str!("contracts-v4.json"))
                .expect("generated extraction contract must parse")
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_contract_parses() {
        assert!(
            !super::ExtractionContractData::get()
                .meaning_instructions
                .is_empty()
        );
    }
}
