//! The merge rules, on payloads built directly.
use super::{Outcome, secret};
use butler_vault::vault::{
    FORMAT, Item, ItemKind, Payload, SecretValue, TOMBSTONE_RETENTION_MS, Tombstone, merge,
};

fn edit(id: &str, updated_at: u64, device: &str, value: &str) -> Item {
    Item {
        id: id.to_owned(),
        kind: ItemKind::Card,
        updated_at,
        device: device.to_owned(),
        value: SecretValue::new(secret(value)),
    }
}

fn deletion(id: &str, deleted_at: u64) -> Tombstone {
    Tombstone {
        id: id.to_owned(),
        deleted_at,
    }
}

fn copy(items: Vec<Item>, tombstones: Vec<Tombstone>) -> Payload {
    Payload {
        format: FORMAT,
        vault_id: "vault".to_owned(),
        seq: 1,
        recipients: vec!["local".to_owned()],
        items,
        tombstones,
    }
}

fn value(payload: &Payload, id: &str) -> Option<String> {
    payload.item(id).map(|item| item.value.expose().to_owned())
}

// test-category: pure-logic
#[test]
fn the_newest_edit_wins_and_the_device_id_breaks_a_tie() -> Outcome {
    butler_e2e::gate!();
    for (left, right, winner) in [
        (edit("a", 5, "x", "old"), edit("a", 6, "x", "new"), "new"),
        (edit("a", 6, "x", "new"), edit("a", 5, "z", "old"), "new"),
        (edit("a", 5, "x", "low"), edit("a", 5, "y", "high"), "high"),
        (edit("a", 5, "y", "high"), edit("a", 5, "x", "low"), "high"),
    ] {
        let merged = merge(&copy(vec![left], vec![]), &copy(vec![right], vec![]));
        assert_eq!(value(&merged, "a").as_deref(), Some(winner));
    }
    let merged = merge(
        &copy(vec![edit("only-local", 1, "x", "1")], vec![]),
        &copy(vec![edit("only-other", 1, "x", "2")], vec![]),
    );
    assert_eq!(merged.items.len(), 2);
    Ok(())
}

// test-category: pure-logic
#[test]
fn a_deletion_beats_older_edits_and_a_newer_edit_beats_a_deletion() -> Outcome {
    butler_e2e::gate!();
    for (updated_at, deleted_at, kept) in [(4, 5, false), (5, 5, false), (6, 5, true)] {
        let merged = merge(
            &copy(vec![edit("a", updated_at, "x", "v")], vec![]),
            &copy(vec![], vec![deletion("a", deleted_at)]),
        );
        assert_eq!(
            merged.item("a").is_some(),
            kept,
            "{updated_at} {deleted_at}"
        );
        assert_eq!(merged.tombstones.is_empty(), kept);
    }
    let merged = merge(
        &copy(vec![], vec![deletion("a", 3)]),
        &copy(vec![], vec![deletion("a", 8)]),
    );
    assert_eq!(merged.tombstones, vec![deletion("a", 8)]);
    Ok(())
}

// test-category: pure-logic
#[test]
fn the_local_vault_id_and_recipients_stay() -> Outcome {
    butler_e2e::gate!();
    let mut incoming = copy(vec![], vec![]);
    incoming.vault_id = "other".to_owned();
    incoming.recipients = vec!["attacker".to_owned()];
    incoming.seq = 40;
    let merged = merge(&copy(vec![], vec![]), &incoming);
    assert_eq!(merged.vault_id, "vault");
    assert_eq!(merged.recipients, vec!["local".to_owned()]);
    assert_eq!(merged.seq, 40);
    Ok(())
}

// test-category: pure-logic
#[test]
fn merging_is_order_free_and_repeatable() -> Outcome {
    butler_e2e::gate!();
    // A small deterministic generator: ids, times and devices that often tie.
    let mut state = 0x2545_f491_u64;
    let mut next = move |limit: u64| {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        (state >> 33) % limit
    };
    let mut generate = || {
        let mut items = Vec::new();
        let mut tombstones = Vec::new();
        for id in ["a", "b", "c", "d"] {
            match next(3) {
                0 => {
                    let time = next(4);
                    let device = ["x", "y"][usize::try_from(next(2)).unwrap()];
                    let body = format!("{device}{time}");
                    items.push(edit(id, time, device, &body));
                }
                1 => tombstones.push(deletion(id, next(4))),
                _ => {}
            }
        }
        copy(items, tombstones)
    };
    let same = |left: &Payload, right: &Payload| {
        assert_eq!(left.items, right.items);
        assert_eq!(left.tombstones, right.tombstones);
    };
    for _ in 0..500 {
        let (a, b, c) = (generate(), generate(), generate());
        same(&merge(&a, &b), &merge(&b, &a));
        same(&merge(&merge(&a, &b), &c), &merge(&a, &merge(&b, &c)));
        same(&merge(&a, &a), &merge(&merge(&a, &a), &a));
        let merged = merge(&a, &b);
        same(&merge(&merged, &a), &merged);
        for item in &merged.items {
            assert!(!merged.tombstones.iter().any(|tomb| tomb.id == item.id));
        }
    }
    Ok(())
}

// test-category: pure-logic
#[test]
fn deletions_are_forgotten_after_180_days() -> Outcome {
    butler_e2e::gate!();
    assert_eq!(TOMBSTONE_RETENTION_MS, 180 * 86_400_000);
    let now = 1_000_000_000_000;
    let mut payload = copy(
        vec![],
        vec![
            deletion("kept", now - TOMBSTONE_RETENTION_MS),
            deletion("dropped", now - TOMBSTONE_RETENTION_MS - 1),
        ],
    );
    payload.prune_tombstones(now);
    assert_eq!(
        payload.tombstones,
        vec![deletion("kept", now - TOMBSTONE_RETENTION_MS)]
    );
    Ok(())
}
