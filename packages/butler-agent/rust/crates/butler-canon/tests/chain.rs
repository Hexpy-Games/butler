#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_canon::work_chain::{Chain, ChainError, Placement, Step, validate_part_dag};
use butler_canon::work_types::TaskId;
use std::collections::BTreeSet;

fn id(s: &str) -> TaskId {
    TaskId(s.into())
}
fn chain(steps: &[&[&str]]) -> Chain {
    Chain {
        steps: steps
            .iter()
            .enumerate()
            .map(|(index, tasks)| Step {
                index,
                tasks: tasks.iter().map(|s| id(s)).collect(),
            })
            .collect(),
    }
}
fn edges(c: &Chain) -> Vec<(TaskId, TaskId)> {
    c.edges().unwrap()
}

// test-category: pure-logic
#[test]
fn edges_connect_only_adjacent_steps_with_all_siblings() {
    let c = chain(&[&["a"], &["b", "c"], &["d"]]);
    assert_eq!(
        edges(&c),
        vec![
            (id("a"), id("b")),
            (id("a"), id("c")),
            (id("b"), id("d")),
            (id("c"), id("d"))
        ]
    );
}

// test-category: pure-logic
#[test]
fn membership_rejects_empty_duplicate_and_noncontiguous_steps() {
    assert!(chain(&[&[]]).validate().is_err());
    assert!(chain(&[&["a"], &["a"]]).validate().is_err());
    let mut bad = chain(&[&["a"]]);
    bad.steps[0].index = 3;
    assert!(bad.validate().is_err());
    chain(&[]).validate().unwrap();
}

// test-category: pure-logic
#[test]
fn delete_relinks_neighbors_and_removes_empty_steps() {
    let c = chain(&[&["a"], &["b"], &["c"]]);
    assert_eq!(
        edges(&c.delete(&id("b"), &BTreeSet::new()).unwrap()),
        vec![(id("a"), id("c"))]
    );
    assert_eq!(
        chain(&[&["a"]]).delete(&id("a"), &BTreeSet::new()).unwrap(),
        chain(&[])
    );
}

// test-category: pure-logic
#[test]
fn deleting_pinned_sibling_ignores_stack_position_in_both_orders() {
    let running = BTreeSet::from([id("a")]);
    for first in [&["x", "a"][..], &["a", "x"][..]] {
        assert_eq!(
            chain(&[first, &["b"]]).delete(&id("x"), &running).unwrap(),
            chain(&[&["a"], &["b"]])
        );
    }
}

// test-category: pure-logic
#[test]
fn running_work_cannot_be_removed_or_change_step() {
    let c = chain(&[&["a"], &["b"], &["c"]]);
    let running = BTreeSet::from([id("a")]);
    assert_eq!(c.delete(&id("a"), &running), Err(ChainError::Pinned));
    assert_eq!(c.detach(&id("a"), &running), Err(ChainError::Pinned));
    assert_eq!(
        c.move_to_new_step(&id("a"), 1, &running),
        Err(ChainError::Pinned)
    );
    assert_eq!(
        c.join_stack(&id("a"), &id("c"), &running),
        Err(ChainError::Pinned)
    );
    assert_eq!(
        c.delete(&id("a"), &BTreeSet::from([id("c")])),
        Err(ChainError::Pinned)
    );
}

// test-category: pure-logic
#[test]
fn running_predecessor_set_is_pinned_even_when_step_does_not_move() {
    let c = chain(&[&["x", "a"], &["b"]]);
    assert_eq!(
        c.delete(&id("x"), &BTreeSet::from([id("b")])),
        Err(ChainError::Pinned)
    );
}

// test-category: pure-logic
#[test]
fn detach_relinks_remaining_steps() {
    assert_eq!(
        chain(&[&["a"], &["b", "c"], &["d"]])
            .detach(&id("a"), &BTreeSet::new())
            .unwrap(),
        chain(&[&["b", "c"], &["d"]])
    );
}

// test-category: pure-logic
#[test]
fn split_preserves_order_and_checks_running_predecessors() {
    let c = chain(&[&["a"], &["b", "c"], &["d"]]);
    let expected = chain(&[&["a"], &["b"], &["c"], &["d"]]);
    assert_eq!(c.split_stack(1, &BTreeSet::new()).unwrap(), expected);
    assert_eq!(
        c.split_stack(1, &BTreeSet::from([id("b")])).unwrap(),
        expected
    );
    assert_eq!(
        c.split_stack(1, &BTreeSet::from([id("c")])),
        Err(ChainError::Pinned)
    );
}

// test-category: pure-logic
#[test]
fn join_stack_removes_an_empty_source_step() {
    assert_eq!(
        chain(&[&["a"], &["b"], &["c"]])
            .join_stack(&id("c"), &id("b"), &BTreeSet::new())
            .unwrap(),
        chain(&[&["a"], &["b", "c"]])
    );
}

// test-category: pure-logic
#[test]
fn move_to_new_step_relinks_an_emptied_source_step() {
    let c = chain(&[&["a"], &["b"], &["c"], &["d"]]);
    let moved = c.move_to_new_step(&id("b"), 3, &BTreeSet::new()).unwrap();
    assert_eq!(moved, chain(&[&["a"], &["c"], &["d"], &["b"]]));
    assert_eq!(
        edges(&moved),
        vec![(id("a"), id("c")), (id("c"), id("d")), (id("d"), id("b"))]
    );
}

// test-category: pure-logic
#[test]
fn after_x_joins_the_next_stack_without_delaying_existing_work() {
    let c = chain(&[&["a", "b"], &["c", "d"], &["e"]]);
    let next = c
        .place_after(id("new"), &id("b"), &BTreeSet::new())
        .unwrap();
    assert_eq!(next, chain(&[&["a", "b"], &["c", "d", "new"], &["e"]]));
    assert!(!edges(&next).contains(&(id("new"), id("c"))));
    assert!(edges(&next).contains(&(id("new"), id("e"))));
}

// test-category: pure-logic
#[test]
fn repeated_appends_create_contiguous_last_steps() {
    let mut c = chain(&[&["a"]]);
    let mut last = id("a");
    for i in 0..100 {
        let next = id(&format!("w{i}"));
        c = c
            .place_after(next.clone(), &last, &BTreeSet::new())
            .unwrap();
        last = next;
    }
    c.validate().unwrap();
    assert_eq!(c.steps.len(), 101);
    assert_eq!(edges(&c).len(), 100);
    assert_eq!(c.steps[100].tasks, vec![last]);
}

// test-category: pure-logic
#[test]
fn move_between_chains_to_new_step_relinks_source_and_keeps_edges_local() {
    let source = chain(&[&["a"], &["b"], &["c"]]);
    let target = chain(&[&["x"], &["y"]]);
    let (source, target) = source
        .move_between(&target, &id("b"), Placement::NewStep(1), &BTreeSet::new())
        .unwrap();
    assert_eq!(source, chain(&[&["a"], &["c"]]));
    assert_eq!(target, chain(&[&["x"], &["b"], &["y"]]));
    assert_eq!(edges(&source), vec![(id("a"), id("c"))]);
    assert_eq!(edges(&target), vec![(id("x"), id("b")), (id("b"), id("y"))]);
    assert!(
        !edges(&source)
            .iter()
            .chain(edges(&target).iter())
            .any(|(a, b)| (a == &id("a") && b == &id("b")) || (a == &id("b") && b == &id("c")))
    );
}

// test-category: pure-logic
#[test]
fn move_between_chains_can_join_stack_or_empty_source() {
    let (source, target) = chain(&[&["a"]])
        .move_between(
            &chain(&[&["x"]]),
            &id("a"),
            Placement::Stack(id("x")),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!(source, chain(&[]));
    assert_eq!(target, chain(&[&["x", "a"]]));
}

// test-category: pure-logic
#[test]
fn move_between_rejects_overlap_unknown_targets_and_running_changes() {
    let c = chain(&[&["a"]]);
    let target = chain(&[&["x"], &["y"]]);
    assert_eq!(
        c.move_between(&c, &id("a"), Placement::NewStep(0), &BTreeSet::new()),
        Err(ChainError::Membership)
    );
    for placement in [Placement::NewStep(8), Placement::Stack(id("missing"))] {
        assert!(
            c.move_between(&target, &id("a"), placement, &BTreeSet::new())
                .is_err()
        );
    }
    for running in [BTreeSet::from([id("a")]), BTreeSet::from([id("y")])] {
        assert_eq!(
            c.move_between(&target, &id("a"), Placement::NewStep(1), &running),
            Err(ChainError::Pinned)
        );
    }
}

// test-category: pure-logic
#[test]
fn edits_reject_unknown_work_step_and_duplicate_membership() {
    let c = chain(&[&["a"], &["b"]]);
    let empty = BTreeSet::new();
    assert!(c.move_to_new_step(&id("a"), 8, &empty).is_err());
    assert!(c.join_stack(&id("a"), &id("missing"), &empty).is_err());
    assert!(c.place_after(id("a"), &id("b"), &empty).is_err());
    assert!(c.place_after(id("c"), &id("missing"), &empty).is_err());
    assert!(c.delete(&id("missing"), &empty).is_err());
    assert!(c.split_stack(8, &empty).is_err());
}

// test-category: pure-logic
#[test]
fn task_dag_accepts_acyclic_edges() {
    assert!(
        validate_part_dag(
            &["a".into(), "b".into(), "c".into()],
            &[("a".into(), "b".into()), ("a".into(), "c".into())]
        )
        .is_ok()
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_unknown_successor() {
    assert_eq!(
        validate_part_dag(&["a".into()], &[("a".into(), "z".into())]),
        Err(ChainError::TaskDag)
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_unknown_predecessor() {
    assert_eq!(
        validate_part_dag(&["a".into()], &[("z".into(), "a".into())]),
        Err(ChainError::TaskDag)
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_self_edges() {
    assert_eq!(
        validate_part_dag(&["a".into()], &[("a".into(), "a".into())]),
        Err(ChainError::TaskDag)
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_duplicate_edges() {
    let edge = ("a".into(), "b".into());
    assert_eq!(
        validate_part_dag(&["a".into(), "b".into()], &[edge.clone(), edge]),
        Err(ChainError::TaskDag)
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_cycles() {
    assert_eq!(
        validate_part_dag(
            &["a".into(), "b".into()],
            &[("a".into(), "b".into()), ("b".into(), "a".into())]
        ),
        Err(ChainError::TaskDag)
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_duplicate_tasks() {
    assert_eq!(
        validate_part_dag(&["a".into(), "a".into()], &[]),
        Err(ChainError::TaskDag)
    );
}
