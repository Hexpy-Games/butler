#![allow(clippy::indexing_slicing, reason = "test assertions")]
use super::*;

pub(crate) fn verify_cache_invalidation() {
    let mut message = ModelRoundMessage::user(r#"{"ok":true}"#.into(), None);
    assert!(!message.facts().succeeded);
    message.role = ModelRoundRole::Tool;
    let original = message.facts();
    assert!(original.succeeded);
    assert!(Arc::ptr_eq(&original, &message.clone().facts()));
    message.content = r#"{"ok":false}"#.into();
    assert!(!message.facts().succeeded);
    message.content = r#"{"ok":true}"#.into();
    assert!(message.facts().succeeded);
    message.tool_calls = Some(vec![super::super::test_data::call("anchor", "start_work")]);
    assert_eq!(message.facts().calls[0].1, "start_work");
    message.tool_calls.as_mut().unwrap()[0].name = "record_work_review".into();
    assert_eq!(message.facts().calls[0].1, "record_work_review");
    let call = &mut message.tool_calls.as_mut().unwrap()[0];
    call.name = "tool_call".into();
    call.raw_arguments = r#"{"id":"native:start_work","arguments":{}}"#.into();
    assert_eq!(message.facts().calls[0].1, "start_work");
    message.tool_calls.as_mut().unwrap()[0].raw_arguments =
        r#"{"id":"native:record_work_review","arguments":{}}"#.into();
    assert_eq!(message.facts().calls[0].1, "record_work_review");
    message.tool_call_id = Some("anchor".into());
    let scan = super::super::operation_result_replay::latest_work_anchor_indices;
    assert_eq!(scan(&[message.clone()]), [0].into());
    message.content = "invalid JSON".into();
    assert!(scan(&[message]).is_empty());
}
