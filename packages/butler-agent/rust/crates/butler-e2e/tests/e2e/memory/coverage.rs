//! MEM-COVERAGE: recall's projection coverage read from the graph's canonical
//! inventory mirror equals a full canonical scan after every kind of source
//! mutation: appended turns, recovered messages, edited and compacted
//! messages, project moves and deleted sessions; while changes are only in
//! the store (overlay) and after the mirror applied them (rows), and for an
//! existing store whose mirror has never been built.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::coverage_support::{
    Variant, canonical, chat, coverage, graph, hide_mirror, hold_gate, pending, recall, recall_in,
    recovered, release_gate, session, settle, show_mirror, start, turn,
};
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Scenario;
use serde_json::json;

const S1: &str = "coverage-s1";
const S2: &str = "coverage-s2";
const S3: &str = "coverage-s3";
/// Keeps the first project selectable after the other sessions leave it.
const S4: &str = "coverage-s4";
const P1: &str = "coverage-p1";
const P2: &str = "coverage-p2";

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

/// Recalls every variant through the mirror and through a full scan of the
/// same unchanged stores; returns whether each reported pending ingestion.
async fn compare(s: &Scenario, chats: &[String], step: &str) -> Result<Vec<bool>, HarnessError> {
    let data = &s.sandbox.data;
    let mut pending_by_variant = Vec::new();
    for (variant, chat) in variants().iter().zip(chats) {
        let (incremental, _) = recall_in(s, chat, variant).await?;
        let phase = hide_mirror(data);
        let (full, _) = recall_in(s, chat, variant).await?;
        show_mirror(data, &phase);
        assert_eq!(
            coverage(&incremental),
            coverage(&full),
            "{step}: {} mirror coverage differs from the full scan",
            variant.prompt
        );
        pending_by_variant.push(pending(&incremental));
    }
    eprintln!("MEM-COVERAGE {step} pending={pending_by_variant:?}");
    Ok(pending_by_variant)
}

#[tokio::test]
async fn mem_coverage_mirror_matches_full_scan() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("MEM-COVERAGE", &variants()).await?;
    let data = s.sandbox.data.clone();
    let mut chats = Vec::new();
    for index in 0..variants().len() {
        chats.push(chat(&s, &format!("Coverage recall {index}")).await?);
    }
    s.turn("general", "Coverage recall over every chat.")
        .await?;
    {
        let db = canonical(&data);
        session(&db, S1, Some(P1));
        session(&db, S2, None);
        session(&db, S3, Some(P1));
        session(&db, S4, Some(P1));
        for n in 1..=4 {
            turn(
                &db,
                S1,
                n,
                &format!("seeded fact {n} in one"),
                "2026-02-10T00:00:00.000Z",
            );
            turn(
                &db,
                S2,
                n,
                &format!("seeded fact {n} in two"),
                "2026-03-10T00:00:00.000Z",
            );
        }
        turn(
            &db,
            S3,
            1,
            "seeded fact in three",
            "2026-02-11T00:00:00.000Z",
        );
    }
    settle(&data, true).await;

    // Migration: an existing store whose mirror was never built.
    let gate = hold_gate(&data);
    graph(&data).execute_batch(
        "DELETE FROM memory_state WHERE key LIKE 'canonical_inventory_%' AND key!='canonical_inventory_format'; \
         DELETE FROM memory_canonical_inventory;",
    ).unwrap();
    let (first, _) = recall(&s, &variants()[0]).await?;
    release_gate(&gate);
    settle(&data, true).await;
    let gate = hold_gate(&data);
    let (rebuilt, _) = recall(&s, &variants()[0]).await?;
    assert_eq!(
        coverage(&first),
        coverage(&rebuilt),
        "first recall before the mirror was built"
    );
    assert_eq!(compare(&s, &chats, "settled").await?[..4], [false; 4]);

    // Store-only changes: the mirror is behind, recall overlays the changes.
    {
        let db = canonical(&data);
        turn(
            &db,
            S1,
            5,
            "seeded fact appended",
            "2026-03-12T00:00:00.000Z",
        );
    }
    assert_eq!(
        compare(&s, &chats, "appended").await?[..4],
        [true, true, false, true]
    );
    {
        let db = canonical(&data);
        db.execute(
            "UPDATE conversation_parts SET content_json=?1 WHERE message_id=?2",
            [
                json!({"text":"seeded fact edited in two"}).to_string(),
                format!("{S2}-turn-1-user"),
            ],
        )
        .unwrap();
        db.execute(
            "UPDATE conversation_sessions SET project_id=?1 WHERE id=?2",
            [P2, S1],
        )
        .unwrap();
    }
    assert_eq!(
        compare(&s, &chats, "edited_moved").await?[..4],
        [true, false, true, true]
    );
    {
        let db = canonical(&data);
        db.execute(
            "UPDATE conversation_messages SET status='compacted' WHERE id=?1",
            [format!("{S2}-turn-1-assistant")],
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
        compare(&s, &chats, "compacted_recovered").await?[..4],
        [true, true, false, true]
    );
    // The App never rewrites message text; restore it before memory sync
    // resumes so projection keeps working on its own sources.
    canonical(&data)
        .execute(
            "UPDATE conversation_parts SET content_json=?1 WHERE message_id=?2",
            [
                json!({"text":"seeded fact 1 in two"}).to_string(),
                format!("{S2}-turn-1-user"),
            ],
        )
        .unwrap();
    release_gate(&gate);

    // The mirror applies the changes and catch-up registers the new sources.
    settle(&data, false).await;
    let gate = hold_gate(&data);
    // The mirror rows now carry every change; projection state is whatever
    // the consumer reached, and both readings must agree on it.
    compare(&s, &chats, "applied").await?;
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
    compare(&s, &chats, "deleted").await?;
    release_gate(&gate);
    s.finish().await
}
