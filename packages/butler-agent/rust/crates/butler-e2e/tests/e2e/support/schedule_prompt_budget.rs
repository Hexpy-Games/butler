//! Ratchet the changed parent instruction/schema bundle against schedule-create 85d866382.
use serde_json::Value;

pub(super) fn assert_budget() {
    let prefixes: Value = serde_json::from_str(include_str!(
        "../../../../butler-turn/src/btcc/guided_turn/phase/instruction-prefixes.json"
    ))
    .unwrap();
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../../butler-runtime/src/capabilities/catalog/catalog.json"
    ))
    .unwrap();
    let tokens = |text: &str| {
        tiktoken_rs::o200k_base_singleton()
            .encode_ordinary(text)
            .len()
    };
    let changed_schema: usize = ["record_work_disposition", "delegate_to_steward"]
        .iter()
        .map(|name| tokens(&catalog["rawDefinitions"][*name].to_string()))
        .sum();
    for (key, prefix) in prefixes.as_object().unwrap() {
        let Some(text) = prefix.as_str() else {
            panic!("prefix is not text");
        };
        if !key.contains("butler") {
            continue;
        }
        if key == "phase_minimal|butler|direct" {
            assert!(tokens(text) <= 182, "direct prefix grew");
            continue;
        }
        let limit = if key == "phase_minimal|butler|read_only" {
            1258
        } else if key == "phase_minimal|butler|execution" {
            1328
        } else if key.ends_with("ledger") {
            3130
        } else {
            3067
        };
        let total = tokens(text) + changed_schema;
        assert!(
            total <= limit,
            "{key}: {total} > {limit}; do not raise the baseline"
        );
        eprintln!("SCHEDULE_PROMPT_BUDGET {key} {total}/{limit}");
    }
}
