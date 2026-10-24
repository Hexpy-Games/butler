// Parser cases extend the epic creation invariant suite.
use butler_canon::store::attachment_references as references;
fn id(n: usize) -> String {
    format!("file-00000000-0000-0000-0000-{n:012}")
}
pub(super) fn markdown_references_match_rendered_links_and_images() {
    let a = id(1);
    let b = id(2);
    let markdown = format!(
        "![a](attachment:{a}) [b][ref] [duplicate](attachment:{a})\n\n[ref]: attachment:{b}\n\n`![](attachment:invalid)`\n\n```\n![](attachment:invalid)\n```\n<img src='attachment:invalid'>"
    );
    assert_eq!(references(&markdown).unwrap(), vec![a, b]);
}
pub(super) fn attachment_limit_counts_unique_references_and_rejects_invalid_ids() {
    let markdown = (0..20)
        .map(|n| format!("![](attachment:{})", id(n)))
        .collect::<String>();
    assert_eq!(references(&markdown).unwrap().len(), 20);
    assert!(references(&(markdown + &format!("[overflow](attachment:{})", id(20)))).is_err());
    assert!(references("![bad](attachment:../../secret)").is_err());
}
