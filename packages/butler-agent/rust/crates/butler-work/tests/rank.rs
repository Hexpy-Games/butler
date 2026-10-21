use butler_work::work_rank::between;

// test-category: pure-logic
#[test]
fn fractional_ranks_sort_and_grow_at_a_bounded_rate() {
    let middle = between(None, None);
    let left = between(None, Some(&middle));
    let right = between(Some(&middle), None);
    assert!(left < middle && middle < right);
    let mut upper = right;
    for _ in 0..1000 {
        let next = between(Some(&middle), Some(&upper));
        assert!(middle < next && next < upper);
        assert!(!next.is_empty());
        upper = next;
    }
    // Base-62 midpoint allocation consumes at most one digit per five halvings.
    assert!(upper.len() <= 205, "{}", upper.len());
    let mut lower = left;
    for _ in 0..1000 {
        let next = between(None, Some(&lower));
        assert!(!next.is_empty() && next < lower);
        lower = next;
    }
    assert!(lower.len() <= 205);
    eprintln!(
        "1000 inserts: fixed gap {} bytes, prepend {} bytes",
        upper.len(),
        lower.len()
    );
}
