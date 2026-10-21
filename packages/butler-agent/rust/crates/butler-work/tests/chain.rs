#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_work::work_chain::{Chain, Step, validate_task_dag};
use butler_work::work_types::WorkId;
use std::collections::BTreeSet;

fn id(s: &str) -> WorkId {
    WorkId(s.into())
}
fn chain(steps: &[&[&str]]) -> Chain {
    Chain {
        steps: steps
            .iter()
            .enumerate()
            .map(|(index, works)| Step {
                index,
                works: works.iter().map(|s| id(s)).collect(),
            })
            .collect(),
    }
}
fn edges(c: &Chain) -> Vec<(WorkId, WorkId)> {
    c.edges().unwrap()
}

// test-category: pure-logic
#[test]
fn chain_invariants_and_all_edits() {
    let empty = BTreeSet::new();
    let c = chain(&[&["a"], &["b", "c"], &["d"]]);
    c.validate().unwrap();
    assert_eq!(
        edges(&c),
        vec![
            (id("a"), id("b")),
            (id("a"), id("c")),
            (id("b"), id("d")),
            (id("c"), id("d"))
        ]
    );
    assert!(!edges(&c).contains(&(id("a"), id("d"))));
    assert!(
        edges(&c)
            .iter()
            .all(|(a, b)| a != &id("other") && b != &id("other"))
    );
    assert!(chain(&[&[]]).validate().is_err());
    assert!(chain(&[&["a"], &["a"]]).validate().is_err());
    let mut bad = c.clone();
    bad.steps[1].index = 3;
    assert!(bad.validate().is_err());
    // The representation is flat: a step contains only WorkId, never steps.
    assert_eq!(
        c.delete(&id("b"), &empty).unwrap(),
        chain(&[&["a"], &["c"], &["d"]])
    );
    let linear = chain(&[&["a"], &["b"], &["c"]]);
    assert_eq!(
        edges(&linear.delete(&id("b"), &empty).unwrap()),
        vec![(id("a"), id("c"))]
    );
    assert_eq!(
        linear.delete(&id("a"), &empty).unwrap(),
        chain(&[&["b"], &["c"]])
    );
    assert_eq!(
        c.detach(&id("a"), &empty).unwrap(),
        chain(&[&["b", "c"], &["d"]])
    );
    assert_eq!(
        c.split_stack(1, &empty).unwrap(),
        chain(&[&["a"], &["b"], &["c"], &["d"]])
    );
    assert_eq!(
        linear.join_stack(&id("c"), &id("b"), &empty).unwrap(),
        chain(&[&["a"], &["b", "c"]])
    );
    assert_eq!(
        c.place_after(id("e"), &id("b"), &empty).unwrap(),
        chain(&[&["a"], &["b", "c"], &["e"], &["d"]])
    );
    assert_eq!(
        linear.move_to_new_step(&id("c"), 0, &empty).unwrap(),
        chain(&[&["c"], &["a"], &["b"]])
    );
    assert!(c.move_to_new_step(&id("a"), 8, &empty).is_err());
    assert!(c.join_stack(&id("a"), &id("missing"), &empty).is_err());
    assert!(c.place_after(id("a"), &id("b"), &empty).is_err());
    let pinned = BTreeSet::from([id("a")]);
    assert!(c.delete(&id("a"), &pinned).is_err());
    assert!(c.move_to_new_step(&id("a"), 1, &pinned).is_err());
    assert!(c.join_stack(&id("a"), &id("b"), &pinned).is_err());
    assert!(c.detach(&id("a"), &pinned).is_err());
    assert!(c.split_stack(1, &BTreeSet::from([id("c")])).is_err());
    assert_eq!(
        c.split_stack(1, &BTreeSet::from([id("b")])).unwrap(),
        chain(&[&["a"], &["b"], &["c"], &["d"]])
    );
    // Reindexing a pinned sibling/step is also movement.
    assert!(c.delete(&id("a"), &BTreeSet::from([id("d")])).is_err());
    assert_eq!(
        chain(&[&["a"]]).delete(&id("a"), &empty).unwrap(),
        chain(&[])
    );
}

// test-category: pure-logic
#[test]
fn task_dag_rejects_unknown_duplicate_self_and_cycles() {
    let tasks = vec!["a".into(), "b".into(), "c".into()];
    let edge = |a: &str, b: &str| (a.to_owned(), b.to_owned());
    assert!(validate_task_dag(&tasks, &[edge("a", "b"), edge("a", "c")]).is_ok());
    for edges in [
        vec![edge("a", "z")],
        vec![edge("a", "a")],
        vec![edge("a", "b"), edge("a", "b")],
        vec![edge("a", "b"), edge("b", "c"), edge("c", "a")],
    ] {
        assert!(validate_task_dag(&tasks, &edges).is_err());
    }
    assert!(validate_task_dag(&["a".into(), "a".into()], &[]).is_err());
}
