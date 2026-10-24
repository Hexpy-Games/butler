#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_canon::work_rank::between;

// test-category: pure-logic
#[test]
fn fractional_ranks_sort_and_grow_at_a_bounded_rate() {
    let middle = between(None, None).unwrap();
    let left = between(None, Some(&middle)).unwrap();
    let right = between(Some(&middle), None).unwrap();
    assert!(left < middle && middle < right);
    let mut upper = right;
    for _ in 0..1000 {
        let next = between(Some(&middle), Some(&upper)).unwrap();
        assert!(middle < next && next < upper);
        assert_ne!(next, "");
        upper = next;
    }
    // Base-62 midpoint allocation consumes at most one digit per five halvings.
    assert!(upper.len() <= 205, "{}", upper.len());
    let mut lower = left;
    for _ in 0..1000 {
        let next = between(None, Some(&lower)).unwrap();
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

// test-category: pure-logic
#[test]
fn adjacent_prefix_and_alphabet_edges_have_strict_midpoints() {
    for (a, b) in [
        (Some("A"), Some("B")),
        (Some("A"), Some("A1")),
        (None, Some("01")),
        (Some("z"), None),
        (Some("9"), Some("A")),
        (Some("Z"), Some("a")),
        (Some("z"), Some("z01")),
    ] {
        let rank = between(a, b).unwrap();
        assert!(a.is_none_or(|a| a < rank.as_str()));
        assert!(b.is_none_or(|b| rank.as_str() < b));
        assert!(!rank.ends_with('0'));
    }
}

// test-category: pure-logic
#[test]
fn invalid_bounds_are_rejected_on_either_side() {
    for invalid in ["", "0", "A0", "~", "a!", "한글", "a\0b"] {
        assert_eq!(between(Some(invalid), None), None, "{invalid:?}");
        assert_eq!(between(None, Some(invalid)), None, "{invalid:?}");
    }
    for (a, b) in [("A", "A"), ("B", "A"), ("A1", "A")] {
        assert_eq!(between(Some(a), Some(b)), None);
    }
}

// test-category: format-pin
#[test]
fn sqlite_plan_rank_order_matches_rust_byte_order() {
    use butler_canon::work_schema;
    use rusqlite::Connection;
    let db = Connection::open_in_memory().unwrap();
    work_schema::ensure(&db).unwrap();
    let mut ranks = vec![between(None, None).unwrap()];
    for i in 0..300 {
        let index = (i * 73) % (ranks.len() + 1);
        let rank = between(
            index.checked_sub(1).map(|j| ranks[j].as_str()),
            ranks.get(index).map(String::as_str),
        )
        .unwrap();
        ranks.insert(index, rank);
    }
    for (i, rank) in ranks.iter().enumerate().rev() {
        db.execute("INSERT INTO canon_epics(id,project_id,title,origin,plan_rank,created_at,updated_at,created_by)
            VALUES(?1,'p','work','board',?2,0,0,'{}')", [i.to_string(), rank.clone()]).unwrap();
    }
    let actual = db
        .prepare("SELECT plan_rank FROM canon_epics ORDER BY plan_rank")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut expected = ranks;
    expected.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), 301);
}
