//! MEM-COVERAGE: recall's projection coverage read from the graph's canonical
//! inventory mirror equals a full canonical scan after every kind of source
//! mutation: appended and regenerated turns, recovered messages (added and
//! attached to a turn), compacted and edited messages, turn status changes,
//! deleted outcomes, turns and sessions (soft and hard), project moves;
//! while changes are only in the store (overlay) and after the mirror
//! applied them (rows), and for an existing store whose mirror was never
//! built.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::coverage_seed::{recovered, regenerate, session, turn};
use super::coverage_support::{
    Variant, canonical, chats, compare, coverage, graph, hold_gate, incomplete_jobs, recall,
    release_gate, settle, start,
};
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Scenario;
use serde_json::json;
use std::path::Path;

const S1: &str = "coverage-s1";
const S2: &str = "coverage-s2";
const S3: &str = "coverage-s3";
/// Keeps the first project selectable after the other sessions leave it.
const S4: &str = "coverage-s4";
/// The recovered message's chat.
const S5: &str = "coverage-s5";
/// A first-project chat that is hard-deleted.
const S6: &str = "coverage-s6";
const P1: &str = "coverage-p1";
const P2: &str = "coverage-p2";
const MARCH: &str = "2026-03-10T00:00:00.000Z";

/// Pending ingestion per variant: both seeded chats, the first project,
/// unassigned seeded chats, March, every chat. "Every chat" is always
/// pending: it includes the recall chats, whose own turns are not projected
/// while the gate is held.
///
/// The recovered chat (the sixth variant) is only compared with the full
/// scan. Its message's job never completes on main: it is rebuilt with the
/// episode revision as the parts hash (`sources/planner.rs:278`,
/// `completion/consumer/process.rs:433`), so the registered-job check keeps
/// it pending. Assert its value too once that is fixed.
type Pending = [bool; 5];

fn variants() -> Vec<Variant> {
    let variant = |prompt, arguments| Variant { prompt, arguments };
    let off = false;
    vec![
        variant(
            "Coverage recall over both seeded chats.",
            json!({"cue":"seeded","session_ids":[S1,S2],"include_vector":off}),
        ),
        variant(
            "Coverage recall over the first project.",
            json!({"cue":"seeded","project_filter":"selected","project_ids":[P1],"include_vector":off}),
        ),
        variant(
            "Coverage recall over unassigned seeded chats.",
            json!({"cue":"seeded","project_filter":"unassigned","session_ids":[S1,S2],"include_vector":off}),
        ),
        variant(
            "Coverage recall over March conversations.",
            json!({"cue":"seeded","session_ids":[S1,S2],"include_vector":off,
            "time":{"basis":"conversation","from":"2026-03-01T00:00:00.000Z","to":"2026-04-01T00:00:00.000Z"}}),
        ),
        variant(
            "Coverage recall over every chat.",
            json!({"cue":"seeded","scope":"all_user_sessions","include_vector":off}),
        ),
        variant(
            "Coverage recall over the recovered chat.",
            json!({"cue":"seeded","session_ids":[S5],"include_vector":off}),
        ),
    ]
}

fn seed(data: &Path) {
    let db = canonical(data);
    for (id, project) in [
        (S1, Some(P1)),
        (S2, None),
        (S3, Some(P1)),
        (S4, Some(P1)),
        (S5, None),
    ] {
        session(&db, id, project);
    }
    for n in 1..=4 {
        let one = format!("seeded fact {n} in one");
        turn(&db, S1, n, &one, "2026-02-10T00:00:00.000Z");
        turn(&db, S2, n, &format!("seeded fact {n} in two"), MARCH);
    }
    turn(
        &db,
        S3,
        1,
        "seeded fact in three",
        "2026-02-11T00:00:00.000Z",
    );
    turn(
        &db,
        S5,
        1,
        "seeded fact in five",
        "2026-02-11T00:00:00.000Z",
    );
}

/// Mutates the store with `change`, then asserts both readings agree and
/// report `expected`.
async fn step(
    s: &Scenario,
    chats: &[String],
    name: &str,
    expected: Pending,
    change: impl FnOnce(&rusqlite::Connection),
) -> Result<(), HarnessError> {
    change(&canonical(&s.sandbox.data));
    let pending = compare(s, &variants(), chats, name).await?;
    assert_eq!(pending[..5], expected, "{name}");
    Ok(())
}

fn execute(db: &rusqlite::Connection, sql: &str, id: &str) {
    db.execute(sql, [id]).unwrap();
}

/// Appends, regenerates, moves, compacts and recovers while the mirror is
/// held behind.
async fn first_changes(s: &Scenario, chats: &[String]) -> Result<(), HarnessError> {
    let t = true;
    let f = false;
    step(s, chats, "appended", [t, t, f, t, t], |db| {
        turn(
            db,
            S1,
            5,
            "seeded fact appended",
            "2026-03-12T00:00:00.000Z",
        );
    })
    .await?;
    step(s, chats, "regenerated_moved", [t, f, t, t, t], |db| {
        regenerate(db, S2, 1, "seeded fact 1 in two, answered again", MARCH);
        db.execute(
            "UPDATE conversation_sessions SET project_id=?1 WHERE id=?2",
            [P2, S1],
        )
        .unwrap();
    })
    .await?;
    step(s, chats, "compacted_recovered", [t, f, f, t, t], |db| {
        let answer = format!("{S2}-turn-1-assistant-2");
        execute(
            db,
            "UPDATE conversation_messages SET status='compacted' WHERE id=?1",
            &answer,
        );
        recovered(
            db,
            S5,
            10,
            "seeded recovered fact",
            "2026-02-12T00:00:00.000Z",
        );
    })
    .await
}

/// Edits, status changes, outcome and session deletes and a recovered
/// message gaining a turn, while the mirror is held behind.
async fn second_changes(s: &Scenario, chats: &[String]) -> Result<(), HarnessError> {
    let (t, f) = (true, false);
    let part = "UPDATE conversation_parts SET content_json='{\"text\":\"seeded fact 2 in two, edited\"}' WHERE message_id=?1";
    step(s, chats, "part_edited", [t, f, t, t, t], |db| {
        execute(db, part, &format!("{S2}-turn-2-assistant"));
    })
    .await?;
    step(s, chats, "status_changed", [f, f, f, f, t], |db| {
        execute(
            db,
            "UPDATE conversation_turns SET status='running' WHERE id=?1",
            &format!("{S2}-turn-2"),
        );
    })
    .await?;
    step(s, chats, "p1_appended", [f, t, f, f, t], |db| {
        turn(db, S4, 1, "seeded fact in four", "2026-02-20T00:00:00.000Z");
    })
    .await?;
    step(s, chats, "outcome_deleted", [f, f, f, f, t], |db| {
        execute(
            db,
            "DELETE FROM conversation_turn_outcomes WHERE turn_id=?1",
            &format!("{S4}-turn-1"),
        );
    })
    .await?;
    step(s, chats, "session_appended", [f, t, f, f, t], |db| {
        session(db, S6, Some(P1));
        turn(db, S6, 1, "seeded fact in six", "2026-02-21T00:00:00.000Z");
    })
    .await?;
    step(s, chats, "session_deleted", [f, f, f, f, t], |db| {
        execute(db, "DELETE FROM conversation_sessions WHERE id=?1", S6);
    })
    .await?;
    step(s, chats, "recovered_attached", [f, f, f, f, t], |db| {
        db.execute(
            "UPDATE conversation_messages SET turn_id=?1 WHERE id=?2",
            [format!("{S5}-turn-1"), format!("{S5}-recovered-10")],
        )
        .unwrap();
    })
    .await
}

#[tokio::test]
async fn mem_coverage_mirror_matches_full_scan() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("MEM-COVERAGE", &variants()).await?;
    let data = s.sandbox.data.clone();
    let chats = chats(&s, variants().len()).await?;
    s.turn("general", "Coverage recall over every chat.")
        .await?;
    seed(&data);
    let projected = [S1, S2, S3];
    settle(&data, &[S1, S2, S3, S5]).await;
    let (t, f) = (true, false);

    // Migration: an existing store whose mirror was never built.
    let gate = hold_gate(&data);
    graph(&data).execute_batch(
        "DELETE FROM memory_state WHERE key LIKE 'canonical_inventory_%' AND key!='canonical_inventory_format'; \
         DELETE FROM memory_canonical_inventory;",
    ).unwrap();
    let (first, _) = recall(&s, &variants()[0]).await?;
    release_gate(&gate);
    settle(&data, &projected).await;
    let gate = hold_gate(&data);
    let (rebuilt, _) = recall(&s, &variants()[0]).await?;
    assert_eq!(
        coverage(&first),
        coverage(&rebuilt),
        "recall before the mirror was built"
    );
    step(&s, &chats, "settled", [f, f, f, f, t], |_| {}).await?;
    first_changes(&s, &chats).await?;
    release_gate(&gate);

    // The mirror applies the changes; catch-up registers the new turn.
    settle(&data, &projected).await;
    let gate = hold_gate(&data);
    eprintln!("MEM-COVERAGE incomplete jobs: {:?}", incomplete_jobs(&data));
    step(&s, &chats, "applied", [f, f, f, f, t], |_| {}).await?;
    second_changes(&s, &chats).await?;
    release_gate(&gate);
    settle(&data, &projected).await;
    let gate = hold_gate(&data);
    step(&s, &chats, "second_applied", [f, f, f, f, t], |_| {}).await?;
    step(&s, &chats, "deleted", [t, f, t, t, t], |db| {
        execute(
            db,
            "UPDATE conversation_sessions SET status='deleted' WHERE id=?1",
            S3,
        );
        execute(
            db,
            "DELETE FROM conversation_turns WHERE id=?1",
            &format!("{S1}-turn-2"),
        );
        turn(
            db,
            S2,
            9,
            "seeded fact after deletion",
            "2026-03-20T00:00:00.000Z",
        );
    })
    .await?;
    release_gate(&gate);
    settle(&data, &projected).await;
    let gate = hold_gate(&data);
    step(&s, &chats, "deletion_applied", [f, f, f, f, t], |_| {}).await?;
    release_gate(&gate);
    s.finish().await
}
