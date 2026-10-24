#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use store_support::*;

// test-category: format-pin
#[test]
fn stored_ranks_reject_invalid_alphabet_and_trailing_minimum_digit() {
    let mut db = db();
    work(&mut db, "work");
    for invalid in ["", "0", "A0", "~", "a!", "한글"] {
        assert!(
            db.execute(
                "UPDATE canon_epics SET plan_rank=?1 WHERE id='work'",
                [invalid]
            )
            .is_err()
        );
    }
    for valid in ["01", "9", "A", "Z", "a", "z"] {
        db.execute(
            "UPDATE canon_epics SET plan_rank=?1 WHERE id='work'",
            [valid],
        )
        .unwrap();
    }
}
