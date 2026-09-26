use super::*;

#[test]
fn borrowed_ranges_match_bun_code_units_json_and_utf8_boundaries() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let slice = Utf16Slice::new(
            text,
            case["start"].as_u64().unwrap() as usize,
            case["end"].as_u64().unwrap() as usize,
        );
        let units: Vec<_> = case["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|unit| unit.as_u64().unwrap() as u16)
            .collect();
        assert_eq!(slice.code_units().collect::<Vec<_>>(), units, "{case}");
        assert_eq!(slice.len_utf16(), units.len(), "{case}");
        assert_eq!(slice.utf8_lossy(), case["utf8"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn scalar_slice_borrows_source_and_unbounded_indices_clamp() {
    let source = "one😀two".to_owned();
    let slice = Utf16Slice::new(&source, 5, usize::MAX);
    assert!(matches!(slice.utf8_lossy(), Cow::Borrowed("two")));
    assert_eq!(slice.body.as_ptr(), source[7..].as_ptr());
    assert_eq!(
        Utf16Slice::new(&source, usize::MAX, usize::MAX).len_utf16(),
        0
    );
    assert_eq!(Utf16Slice::new(&source, 0, usize::MAX).len_utf16(), 8);
}
