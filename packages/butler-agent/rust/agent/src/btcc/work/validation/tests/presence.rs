use super::super::*;
use serde_json::Value;

#[test]
fn actual_bun_plan_effect_presence_and_validation_order_match() {
    let fixture: Value = serde_json::from_str(include_str!("../../presence-golden.json")).unwrap();
    for row in fixture["plans"].as_array().unwrap() {
        let input: ReplacePlanInput = serde_json::from_value(row["input"].clone()).unwrap();
        let error = validate_replace(&input).err().map(|error| error.message);
        assert_validation(error.as_deref(), &row["validationError"], &row["label"]);
        assert_eq!(
            input.actions.iter().any(|action| action.effect.is_some()),
            row["acceptedPlan"].as_bool().unwrap(),
            "{}",
            row["label"]
        );
        // The persisted action is not allowed to silently erase null or extras.
        assert_eq!(
            serde_json::to_value(&input.actions).unwrap(),
            row["input"]["actions"],
            "{}",
            row["label"]
        );
    }
    for row in fixture["checkpoints"].as_array().unwrap() {
        let input: CheckpointInput = serde_json::from_value(row["input"].clone()).unwrap();
        let error = validate_checkpoint(&input).err().map(|error| error.message);
        assert_validation(error.as_deref(), &row["validationError"], &Value::Null);
    }
}

fn assert_validation(actual: Option<&str>, expected: &Value, label: &Value) {
    if expected["name"] == "TypeError" {
        // Wrong-shaped truthy markers remain rejected. JSC's missing-property
        // exception prose is engine-specific, not a native diagnostic contract.
        assert!(actual.is_some(), "{label}");
    } else {
        assert_eq!(actual, expected["message"].as_str(), "{label}");
    }
}
