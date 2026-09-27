#[test]
fn nonfinite_attachment_is_unknown_in_text_and_null_in_json_reference() {
    let mut request = super::request();
    request.message.attachments[1].id = "a2".into();
    request.message.attachments[1].size_bytes = Some(f64::INFINITY);
    let binding = super::binding(crate::workspace::SessionRole::Butler);
    let section = super::super::runtime::current_attachments(&request, &binding).unwrap();
    assert!(section.content.contains("a2"));
    assert!(section.content.contains("unknown size"));
    let references = super::super::runtime::attachment_references(&request);
    assert_eq!(
        references[1]["metadata"]["sizeBytes"],
        serde_json::Value::Null
    );
}
