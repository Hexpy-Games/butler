use super::*;

#[test]
fn scalar_slice_uses_utf16_units_and_unbounded_indices_clamp() {
    let source = "one😀two".to_owned();
    let slice = Utf16Slice::new(&source, 5, usize::MAX);
    assert_eq!(slice.utf8_lossy(), "two");
    assert_eq!(
        Utf16Slice::new(&source, usize::MAX, usize::MAX).len_utf16(),
        0
    );
    assert_eq!(Utf16Slice::new(&source, 0, usize::MAX).len_utf16(), 8);
}
