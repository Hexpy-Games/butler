#![allow(clippy::unwrap_used, reason = "test assertions")]
// Pure validation assertions accompany the existing authority test.
// Invoked by the existing authority admission test; keep the non-E2E test count flat.
use super::questions::{UserQuestionResponse, UserQuestions};
use serde_json::json;
pub(super) fn schema_and_answer_validation() {
    let valid = json!({"questions":[{"id":"q","eyebrow":"Topic","title":"Choose?","kind":"single","allow_custom":true,
        "options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]});
    let parsed: UserQuestions = serde_json::from_value(valid.clone()).unwrap();
    assert!(parsed.validate().is_ok());
    for count in [0, 5] {
        let mut input = valid.clone();
        input["questions"] = json!(vec![input["questions"][0].clone(); count]);
        assert!(
            serde_json::from_value::<UserQuestions>(input)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    for count in [1, 7] {
        let mut input = valid.clone();
        input["questions"][0]["options"] =
            json!(vec![input["questions"][0]["options"][0].clone(); count]);
        assert!(
            serde_json::from_value::<UserQuestions>(input)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    for field in ["icon", "type"] {
        let mut input = valid.clone();
        input["questions"][0][field] = json!("invalid");
        assert!(serde_json::from_value::<UserQuestions>(input).is_err());
    }
    let mut duplicate = valid.clone();
    duplicate["questions"][0]["options"][1]["id"] = json!("a");
    assert!(
        serde_json::from_value::<UserQuestions>(duplicate)
            .unwrap()
            .validate()
            .is_err()
    );
    for selected in [vec!["a", "b"], vec!["missing"], vec!["a", "a"]] {
        let answer: UserQuestionResponse = serde_json::from_value(json!({"status":"answered","answers":[{"id":"q","selected":selected,"custom":null,"skipped":false}]})).unwrap();
        assert!(parsed.validate_answer(&answer).is_err());
    }
    for response in [
        json!({"status":"deferred"}),
        json!({"status":"answered","answers":[{"id":"q","selected":[],"custom":null,"skipped":true}]}),
        json!({"status":"answered","answers":[{"id":"q","selected":[],"custom":"my choice","skipped":false}]}),
    ] {
        assert!(
            parsed
                .validate_answer(&serde_json::from_value(response).unwrap())
                .is_ok()
        );
    }
}
