#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_work::work_schema;
use rusqlite::Connection;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    work_schema::ensure(&db).unwrap();
    db.execute_batch("INSERT INTO wm_work_chains(id,session_id,created_at) VALUES('ch','chat',0);
        INSERT INTO wm_works(id,scope_kind,scope_ref,title,visibility,origin,chain_id,step_index,stack_position,created_at,updated_at,created_by)
        VALUES('a','session','chat','A','private','chat','ch',0,0,0,0,'{}'),
        ('b','session','chat','B','private','chat','ch',1,0,0,0,'{}');").unwrap();
    db
}

// test-category: format-pin
#[test]
fn set_based_chain_renumbering_allows_transient_collisions() {
    let db = database();
    assert_eq!(
        db.execute(
            "UPDATE wm_works SET step_index=step_index+1 WHERE chain_id='ch'",
            []
        )
        .unwrap(),
        2
    );
    let rows = db
        .prepare("SELECT id,step_index FROM wm_works ORDER BY step_index")
        .unwrap()
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, vec![("a".into(), 1), ("b".into(), 2)]);
    for column in ["step_index", "stack_position"] {
        assert!(
            db.execute(&format!("UPDATE wm_works SET {column}=-1 WHERE id='a'"), [])
                .is_err()
        );
    }
}

// test-category: format-pin
#[test]
fn hold_and_failure_fields_match_state_in_both_directions() {
    let db = database();
    for change in [
        "run_state='held'",
        "hold_reason='predecessor_failed'",
        "held_by_work_id='b'",
        "run_state='failed'",
        "failure_reason='failure'",
    ] {
        assert!(
            db.execute(&format!("UPDATE wm_works SET {change} WHERE id='a'"), [])
                .is_err()
        );
    }
    db.execute("UPDATE wm_works SET run_state='held',hold_reason='predecessor_failed',held_by_work_id='b' WHERE id='a'", []).unwrap();
    for change in [
        "run_state='idle'",
        "hold_reason=NULL",
        "held_by_work_id=NULL",
    ] {
        assert!(
            db.execute(&format!("UPDATE wm_works SET {change} WHERE id='a'"), [])
                .is_err()
        );
    }
    db.execute("UPDATE wm_works SET run_state='failed',hold_reason=NULL,held_by_work_id=NULL,failure_reason='failure' WHERE id='a'", []).unwrap();
    assert!(
        db.execute("UPDATE wm_works SET run_state='idle' WHERE id='a'", [])
            .is_err()
    );
    assert!(
        db.execute("UPDATE wm_works SET failure_reason=NULL WHERE id='a'", [])
            .is_err()
    );
    db.execute(
        "UPDATE wm_works SET run_state='idle',failure_reason=NULL WHERE id='a'",
        [],
    )
    .unwrap();
}

// test-category: format-pin
#[test]
fn only_one_undecided_hold_per_chain_step() {
    let db = database();
    let insert = "INSERT INTO wm_hold_decisions(id,chain_id,failed_work_id,held_step_index,question_message_id) VALUES(?1,'ch','a',?2,'question')";
    db.execute(insert, ("first", 1)).unwrap();
    assert!(db.execute(insert, ("second", 1)).is_err());
    db.execute(insert, ("other-step", 2)).unwrap();
    db.execute(
        "UPDATE wm_hold_decisions SET decision='delete',decided_at=1 WHERE id='first'",
        [],
    )
    .unwrap();
    db.execute(insert, ("second", 1)).unwrap();
}

// test-category: format-pin
#[test]
fn stored_ranks_reject_invalid_alphabet_and_trailing_minimum_digit() {
    let db = database();
    db.execute_batch("INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,created_at,updated_at,created_by)
        VALUES('t','a','{}','Task','execute','draft','V',0,0,'{}');").unwrap();
    for invalid in ["", "0", "A0", "~", "a!", "한글"] {
        assert!(
            db.execute("UPDATE wm_works SET plan_rank=?1 WHERE id='a'", [invalid])
                .is_err()
        );
        assert!(
            db.execute("UPDATE wm_tasks SET task_rank=?1 WHERE id='t'", [invalid])
                .is_err()
        );
    }
    for valid in ["01", "9", "A", "Z", "a", "z"] {
        db.execute("UPDATE wm_works SET plan_rank=?1 WHERE id='a'", [valid])
            .unwrap();
        db.execute("UPDATE wm_tasks SET task_rank=?1 WHERE id='t'", [valid])
            .unwrap();
    }
    db.execute("UPDATE wm_works SET plan_rank=NULL WHERE id='a'", [])
        .unwrap();
}
