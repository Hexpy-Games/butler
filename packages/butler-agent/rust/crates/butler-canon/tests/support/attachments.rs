// Markdown reference extraction is pure logic, independent of entity mutation.
use butler_canon::store::attachment_references as references;
use std::fmt::Write as _;
fn id(n: usize) -> String {
    format!("file-00000000-0000-0000-0000-{n:012}")
}
// test-category: pure-logic
#[test]
fn markdown_references_match_rendered_links_and_images() {
    let a = id(1);
    let b = id(2);
    let markdown = format!(
        "![a](attachment:{a}) [b][ref] [duplicate](attachment:{a})\n\n[ref]: attachment:{b}\n\n`![](attachment:invalid)`\n\n```\n![](attachment:invalid)\n```\n<img src='attachment:invalid'>"
    );
    assert_eq!(references(&markdown).unwrap(), vec![a.clone(), b]);
    assert_eq!(
        references(&format!("[upper](AtTaChMeNt:{a})")).unwrap(),
        vec![a]
    );
}
// test-category: pure-logic
#[test]
fn attachment_limit_counts_unique_references_and_rejects_invalid_ids() {
    let mut markdown = String::new();
    for n in 0..20 {
        write!(markdown, "![](attachment:{})", id(n)).unwrap();
    }
    assert_eq!(references(&markdown).unwrap().len(), 20);
    assert!(
        references(&(markdown.clone() + &format!("[overflow](attachment:{})", id(20)))).is_err()
    );
    assert!(references("![bad](attachment:../../secret)").is_err());
    let historical = markdown + "[old](attachment:invalid)";
    assert_eq!(
        butler_canon::store::attachment_references_lenient(&historical).len(),
        21
    );
}
