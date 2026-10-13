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
    // Free text: a text question takes no options and answers with free input only.
    let text = json!({"questions":[{"id":"name","eyebrow":"Name","title":"Your name?","kind":"text","allow_custom":false,"options":[]}]});
    let text: UserQuestions = serde_json::from_value(text).unwrap();
    assert!(text.validate().is_ok());
    let text = text.normalized();
    assert!(text.questions[0].allow_custom, "text always has the input");
    let typed = json!({"status":"answered","answers":[{"id":"name","selected":[],"custom":"Grace","skipped":false}]});
    assert!(
        text.validate_answer(&serde_json::from_value(typed).unwrap())
            .is_ok()
    );
    let mut with_options = valid.clone();
    with_options["questions"][0]["kind"] = json!("text");
    let with_options: UserQuestions = serde_json::from_value(with_options).unwrap();
    assert!(
        with_options.validate().is_err(),
        "text with options is fed back"
    );
    // Skip and free-input options duplicate the card's own controls; they are dropped by kind.
    let duplicates = json!({"questions":[{"id":"q","eyebrow":"Topic","title":"Choose?","kind":"single","allow_custom":false,
        "options":[{"id":"a","label":"A","kind":"answer"},{"id":"own","label":"Mine","kind":"input"},{"id":"later","label":"Later","kind":"skip"}]}]});
    let duplicates: UserQuestions = serde_json::from_value(duplicates).unwrap();
    assert!(duplicates.validate().is_ok());
    let kept = duplicates.normalized();
    assert_eq!(kept.questions[0].options.len(), 1);
    assert!(
        kept.questions[0].allow_custom,
        "a dropped input option turns free input on"
    );
    assert!(kept.validate_normalized().is_ok() && kept.validate().is_err());
    assert!(
        serde_json::to_value(&kept).unwrap()["questions"][0]["options"][0]
            .get("kind")
            .is_none(),
        "stored answers keep their prior shape"
    );
    let only_controls = json!({"questions":[{"id":"q","eyebrow":"Name","title":"Your name?","kind":"single","allow_custom":true,
        "options":[{"id":"tell","label":"I'll tell you","kind":"input"},{"id":"skip","label":"Skip","kind":"skip"}]}]});
    let only_controls = serde_json::from_value::<UserQuestions>(only_controls)
        .unwrap()
        .normalized();
    assert_eq!(
        serde_json::to_value(&only_controls.questions[0]).unwrap(),
        json!({"id":"q","eyebrow":"Name","title":"Your name?","kind":"text","allow_custom":true,"options":[]}),
        "no concrete answer left: one input"
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
