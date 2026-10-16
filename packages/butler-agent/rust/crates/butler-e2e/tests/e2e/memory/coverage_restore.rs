//! MEM-COVERAGE-RESTORE: the inventory mirror never answers for a store it
//! does not describe. An older backup restored and grown back to the
//! mirror's watermark is read with a full scan and rebuilt; an unreadable
//! turn in a deleted chat neither stops the mirror nor fails a recall.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::coverage_seed::{back_up, restore, session, turn, unreadable_turn};
use super::coverage_support::{
    Variant, canonical, canonical_path, canonical_position, chats, compare, graph, hold_gate,
    mirror_settled, release_gate, settle, start,
};
use butler_e2e::e2e::HarnessError;
use serde_json::json;

const KEPT: &str = "restore-kept";
const GONE: &str = "restore-deleted";

fn variants() -> Vec<Variant> {
    vec![
        Variant {
            prompt: "Coverage recall over the kept chat.",
            arguments: json!({"cue":"restored","session_ids":[KEPT],"include_vector":false}),
        },
        Variant {
            prompt: "Coverage recall over every chat after restore.",
            arguments: json!({"cue":"restored","scope":"all_user_sessions","include_vector":false}),
        },
    ]
}

fn mirror_mark(data: &std::path::Path) -> (i64, String) {
    graph(data)
        .query_row(
            "SELECT (SELECT value FROM memory_state WHERE key='canonical_inventory_seq'),\
             (SELECT value FROM memory_state WHERE key='canonical_inventory_seq_key')",
            [],
            |row| Ok((row.get::<_, String>(0)?.parse().unwrap(), row.get(1)?)),
        )
        .unwrap()
}

#[tokio::test]
async fn mem_coverage_restore_and_unreadable_sources() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("MEM-COVERAGE-RESTORE", &variants()).await?;
    let data = s.sandbox.data.clone();
    let chats = chats(&s, variants().len()).await?;
    s.turn("general", variants()[1].prompt).await?;
    {
        let db = canonical(&data);
        session(&db, KEPT, None);
        for n in 1..=3 {
            let text = format!("restored fact {n}");
            turn(&db, KEPT, n, &text, "2026-02-10T00:00:00.000Z");
        }
    }
    settle(&data, &[KEPT]).await;
    // Back up, let the mirror move past the backup, then restore the backup
    // and grow it back to the mirror's watermark with other turns.
    let backup = s.sandbox.root.join("conversation-store.backup.sqlite");
    back_up(&canonical(&data), &backup);
    for n in 4..=5 {
        turn(
            &canonical(&data),
            KEPT,
            n,
            &format!("restored fact {n}"),
            "2026-02-11T00:00:00.000Z",
        );
    }
    settle(&data, &[KEPT]).await;
    let (watermark, key) = mirror_mark(&data);
    s.agent.terminate().await?;
    restore(&backup, &canonical_path(&data));
    let mut n = 100;
    while canonical_position(&data).1 < watermark {
        turn(
            &canonical(&data),
            KEPT,
            n,
            &format!("restored late fact {n}"),
            "2026-02-12T00:00:00.000Z",
        );
        n += 1;
    }
    assert_eq!(canonical_position(&data).1, watermark);
    let gate = hold_gate(&data);
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        mirror_mark(&data),
        (watermark, key),
        "the mirror still names the lost change"
    );
    let pending = compare(&s, &variants(), &chats, "restored").await?;
    assert!(
        pending[0],
        "turns written after the restore are not projected yet"
    );
    release_gate(&gate);
    mirror_settled(&data).await;
    let lost: i64 = graph(&data)
        .query_row(
            "SELECT COUNT(*) FROM memory_canonical_inventory WHERE entity_id IN (?1,?2)",
            [format!("{KEPT}-turn-4"), format!("{KEPT}-turn-5")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        lost, 0,
        "the rebuilt mirror still holds turns the restore removed"
    );

    // An unreadable turn in a deleted chat: the full scan never reads it,
    // and the mirror keeps it as a fault row instead of stopping.
    {
        let db = canonical(&data);
        session(&db, GONE, None);
        db.execute(
            "UPDATE conversation_sessions SET status='deleted' WHERE id=?1",
            [GONE],
        )
        .unwrap();
        unreadable_turn(&db, GONE, 1, "2026-02-13T00:00:00.000Z");
    }
    mirror_settled(&data).await;
    let unreadable: i64 = graph(&data)
        .query_row(
            "SELECT COUNT(*) FROM memory_canonical_inventory WHERE fault IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unreadable, 1);
    let gate = hold_gate(&data);
    compare(&s, &variants(), &chats, "unreadable").await?;
    release_gate(&gate);
    s.finish().await
}
