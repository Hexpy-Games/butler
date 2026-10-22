#![allow(clippy::unwrap_used, reason = "format-pin assertions")]
// test-category: format-pin
#[test]
fn delegation_accepts_only_parts() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let catalog = butler_core::tool_catalog::load()?;
    for name in ["delegate_to_steward", "delegate_to_worker"] {
        let tool = catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap();
        let fields = &tool["definition"]["parameters"]["properties"];
        assert!(
            fields.get("task_id").is_none(),
            "{name} must never transfer the Task lease"
        );
        assert!(fields.get("part_id").is_some());
    }
    Ok(())
}
