//! Process identity changes on each boot; all managed data stays exact.
use super::{HarnessError, Snapshot, Value};

pub(super) fn assert_closed_boot(snapshot: &Snapshot, boots: usize) -> Result<(), HarnessError> {
    let marker = &snapshot["wm_runtime_marker"];
    assert_eq!(marker.len(), 1);
    assert_eq!(marker[0].len(), 4);
    assert_eq!(marker[0][0], Value::Integer(1));
    let Value::Text(boot) = &marker[0][1] else {
        panic!("boot identity")
    };
    assert!(uuid::Uuid::parse_str(boot).is_ok());
    let (Value::Integer(start), Value::Integer(clean)) = (&marker[0][2], &marker[0][3]) else {
        panic!("clean shutdown marker")
    };
    assert!(clean >= start);
    let lifecycle: Vec<_> = snapshot["wm_audit"]
        .iter()
        .filter(|row| row[1] == Value::Text("runtime_marker".into()))
        .collect();
    assert_eq!(lifecycle.len(), boots * 2);
    let (pairs, remainder) = lifecycle.as_chunks::<2>();
    assert_eq!(remainder, [] as [&Vec<Value>; 0]);
    for pair in pairs {
        assert_eq!(pair[0][5], Value::Text("begin_boot".into()));
        assert_eq!(pair[1][5], Value::Text("clean_shutdown".into()));
        assert_eq!(pair[0][2], pair[1][2]);
        assert_eq!(pair[0][4], Value::Text("{\"runtime\":\"recovery\"}".into()));
        assert_eq!(pair[1][4], pair[0][4]);
    }
    assert_eq!(lifecycle.last().unwrap()[2], marker[0][1]);
    Ok(())
}

pub(super) fn advance(before: &mut Snapshot, after: &Snapshot) -> Result<(), HarnessError> {
    let count = before["wm_audit"]
        .iter()
        .filter(|row| row[1] == Value::Text("runtime_marker".into()))
        .count()
        / 2;
    assert_closed_boot(after, count + 1)?;
    assert_ne!(
        before["wm_runtime_marker"][0][1],
        after["wm_runtime_marker"][0][1]
    );
    let old = &before["wm_audit"];
    let new = &after["wm_audit"];
    assert_eq!(
        &new[..old.len()],
        old.as_slice(),
        "prior audit is immutable"
    );
    assert_eq!(
        new.len(),
        old.len() + 2,
        "only the two process lifecycle events are new"
    );
    before.insert(
        "wm_runtime_marker".into(),
        after["wm_runtime_marker"].clone(),
    );
    before.insert("wm_audit".into(), new.clone());
    Ok(())
}
