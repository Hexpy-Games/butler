//! MEM-COVERAGE: recall's projection coverage read from the graph's canonical
//! inventory mirror equals a full canonical scan after every kind of source
//! mutation: appended and regenerated turns, recovered messages, compacted
//! messages, project moves, deleted sessions and turns; while changes are
//! only in the store (overlay) and after the mirror applied them (rows), and
//! for an existing store whose mirror has never been built.
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
use serde_json::json;

const S1: &str = "coverage-s1";
const S2: &str = "coverage-s2";
const S3: &str = "coverage-s3";
/// Keeps the first project selectable after the other sessions leave it.
const S4: &str = "coverage-s4";
const P1: &str = "coverage-p1";
const P2: &str = "coverage-p2";
const MARCH: &str = "2026-03-10T00:00:00.000Z";

fn variants() -> Vec<Variant> {
    vec![
        Variant {
            prompt: "Coverage recall over both seeded chats.",
            arguments: json!({"cue":"seeded","session_ids":[S1,S2],"include_vector":false}),
        },
        Variant {
            prompt: "Coverage recall over the first project.",
            arguments: json!({"cue":"seeded","project_filter":"selected","project_ids":[P1],"include_vector":false}),
        },
        Variant {
            prompt: "Coverage recall over unassigned seeded chats.",
            arguments: json!({"cue":"seeded","project_filter":"unassigned","session_ids":[S1,S2],"include_vector":false}),
        },
        Variant {
            prompt: "Coverage recall over March conversations.",
            arguments: json!({"cue":"seeded","session_ids":[S1,S2],"include_vector":false,
                "time":{"basis":"conversation","from":"2026-03-01T00:00:00.000Z","to":"2026-04-01T00:00:00.000Z"}}),
        },
        Variant {
            prompt: "Coverage recall over every chat.",
            arguments: json!({"cue":"seeded","scope":"all_user_sessions","include_vector":false}),
        },
    ]
}

fn seed(data: &std::path::Path) {
    let db = canonical(data);
    session(&db, S1, Some(P1));
    session(&db, S2, None);
    session(&db, S3, Some(P1));
    session(&db, S4, Some(P1));
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
    settle(&data, &[S1, S2, S3]).await;

    // Migration: an existing store whose mirror was never built.
    let gate = hold_gate(&data);
    graph(&data).execute_batch(
        "DELETE FROM memory_state WHERE key LIKE 'canonical_inventory_%' AND key!='canonical_inventory_format'; \
         DELETE FROM memory_canonical_inventory;",
    ).unwrap();
    let (first, _) = recall(&s, &variants()[0]).await?;
    release_gate(&gate);
    settle(&data, &[S1, S2, S3]).await;
    let gate = hold_gate(&data);
    let (rebuilt, _) = recall(&s, &variants()[0]).await?;
    assert_eq!(
        coverage(&first),
        coverage(&rebuilt),
        "recall before the mirror was built"
    );
    let v = variants();
    assert_eq!(compare(&s, &v, &chats, "settled").await?[..4], [false; 4]);

    // Store-only changes: the mirror is behind, recall overlays the changes.
    turn(
        &canonical(&data),
        S1,
        5,
        "seeded fact appended",
        "2026-03-12T00:00:00.000Z",
    );
    assert_eq!(
        compare(&s, &v, &chats, "appended").await?[..4],
        [true, true, false, true]
    );
    {
        let db = canonical(&data);
        regenerate(&db, S2, 1, "seeded fact 1 in two, answered again", MARCH);
        db.execute(
            "UPDATE conversation_sessions SET project_id=?1 WHERE id=?2",
            [P2, S1],
        )
        .unwrap();
    }
    assert_eq!(
        compare(&s, &v, &chats, "regenerated_moved").await?[..4],
        [true, false, true, true]
    );
    {
        let db = canonical(&data);
        db.execute(
            "UPDATE conversation_messages SET status='compacted' WHERE id=?1",
            [format!("{S2}-turn-1-assistant-2")],
        )
        .unwrap();
        recovered(
            &db,
            S3,
            10,
            "seeded recovered fact",
            "2026-02-12T00:00:00.000Z",
        );
    }
    assert_eq!(
        compare(&s, &v, &chats, "compacted_recovered").await?[..4],
        [true, true, false, true]
    );
    release_gate(&gate);

    // The mirror applies the changes; catch-up registers and projection
    // completes the new turn. The compacted turn is out. The recovered
    // message never finishes projection (its job is rebuilt with the episode
    // revision as the parts hash), so the first project is only compared.
    settle(&data, &[S1, S2]).await;
    let gate = hold_gate(&data);
    eprintln!("MEM-COVERAGE incomplete jobs: {:?}", incomplete_jobs(&data));
    let applied = compare(&s, &v, &chats, "applied").await?;
    assert_eq!([applied[0], applied[2], applied[3]], [false; 3]);
    {
        let db = canonical(&data);
        db.execute(
            "UPDATE conversation_sessions SET status='deleted' WHERE id=?1",
            [S3],
        )
        .unwrap();
        db.execute(
            "DELETE FROM conversation_turns WHERE id=?1",
            [format!("{S1}-turn-2")],
        )
        .unwrap();
        turn(
            &db,
            S2,
            9,
            "seeded fact after deletion",
            "2026-03-20T00:00:00.000Z",
        );
    }
    let deleted = compare(&s, &v, &chats, "deleted").await?;
    assert_eq!([deleted[0], deleted[2], deleted[3]], [true; 3]);
    release_gate(&gate);
    settle(&data, &[S1, S2]).await;
    let gate = hold_gate(&data);
    let applied = compare(&s, &v, &chats, "deletion_applied").await?;
    assert_eq!([applied[0], applied[2], applied[3]], [false; 3]);
    release_gate(&gate);
    s.finish().await
}
