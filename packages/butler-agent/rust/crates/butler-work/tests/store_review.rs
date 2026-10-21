#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use store_support::*;
fn decide(db: &mut rusqlite::Connection, decision: Decision) {
    let tx = db.transaction().unwrap();
    let q = undecided_holds(&tx, "ch").unwrap().remove(0);
    decide_hold(&tx, &context(), q["id"].as_str().unwrap(), q["revision"].as_i64().unwrap(), graph(&tx,"ch"), decision).unwrap();
    tx.commit().unwrap();
}
fn edit(db: &mut rusqlite::Connection, op: QueueEdit) -> Result<()> {
    let tx = db.transaction().unwrap();
    edit_queue(&tx,&context(), &[("ch".into(),graph(&tx,"ch"))], &member_revisions(&tx,"ch"), &[op])?;
    tx.commit().unwrap();
    Ok(())
}
fn append(db: &mut rusqlite::Connection, id: &str, after: &str) {
    work(db,id);
    let tx = db.transaction().unwrap();
    place_after(&tx,&context(),id,0,after,graph(&tx,"ch")).unwrap();
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn held_cannot_escape_via_runtime() {
    for state in [RunState::Running,RunState::Waiting] {
        let mut db=db(); queue(&mut db,&["a","b"]);
        runtime(&mut db,"a",RunState::Failed,false);
        let tx=db.transaction().unwrap();
        assert!(transition(&tx,&context(),"b",revision(&tx,"b"),state,false,None,None).is_err());
    }
}
// test-category: pure-logic
#[test]
fn repeated_failure_preserves_running_follower() {
    let mut db=db(); queue(&mut db,&["a","b","c"]);
    runtime(&mut db,"a",RunState::Failed,false); decide(&mut db,Decision::RunAnyway);
    runtime(&mut db,"b",RunState::Running,false);
    runtime(&mut db,"a",RunState::Running,false); runtime(&mut db,"a",RunState::Failed,false);
    assert_eq!(read_work(&db,"b").unwrap()["run_state"],"running");
}
// test-category: pure-logic
#[test]
fn approval_does_not_transfer_after_renumbering() {
    let mut db=db(); queue(&mut db,&["a","b","c"]);
    runtime(&mut db,"a",RunState::Failed,false); decide(&mut db,Decision::RunAnyway);
    runtime(&mut db,"b",RunState::Running,false); runtime(&mut db,"b",RunState::Failed,false);
    decide(&mut db,Decision::Delete); append(&mut db,"w","b");
    edit(&mut db,QueueEdit::Delete{chain_id:"ch".into(),work_id:"a".into()}).unwrap();
    assert!(!ready_works(&db,"ch").unwrap().contains(&"w".into()));
    assert_eq!(read_work(&db,"w").unwrap()["run_state"],"held");
    assert_eq!(undecided_holds(&db,"ch").unwrap().len(),1);
}
// test-category: pure-logic
#[test]
fn inserted_followers_are_derived_and_deleted_together() {
    let mut db=db(); queue(&mut db,&["x","y"]);
    runtime(&mut db,"x",RunState::Failed,false); append(&mut db,"w","y");
    assert_eq!(read_work(&db,"w").unwrap()["run_state"],"held");
    decide(&mut db,Decision::Delete);
    assert_eq!(read_work(&db,"w").unwrap()["run_state"],"cancelled");
}
// test-category: pure-logic
#[test]
fn stacked_failure_repoints_existing_question() {
    let mut db=db(); queue(&mut db,&["a","b"]); append(&mut db,"s","a");
    edit(&mut db,QueueEdit::JoinStack{chain_id:"ch".into(),work_id:"s".into(),target:"a".into()}).unwrap();
    runtime(&mut db,"a",RunState::Failed,false); runtime(&mut db,"s",RunState::Failed,false);
    let before=undecided_holds(&db,"ch").unwrap().remove(0);
    let tx=db.transaction().unwrap();
    set_label(&tx,&context(),"a",revision(&tx,"a"),CanonStatus::Done,&UserAct::new("tester"),Some(graph(&tx,"ch"))).unwrap();
    let questions=undecided_holds(&tx,"ch").unwrap();
    assert_eq!(questions.len(),1); assert_eq!(questions[0]["id"],before["id"]);
    assert_eq!(questions[0]["failed_work_id"],"s");
    assert_eq!(read_work(&tx,"b").unwrap()["held_by_work_id"],"s");
}
// test-category: pure-logic
#[test]
fn terminal_delete_preserves_completion_and_detach_rejects() {
    for state in [RunState::Done,RunState::Cancelled] {
        let mut db=db(); queue(&mut db,&["a","b"]);
        // A terminal queued snapshot is valid even for cancelled historical members.
        db.execute("UPDATE wm_works SET run_state=?1,result_reported_at=42 WHERE id='a'",[state.as_str()]).unwrap();
        let before=read_work(&db,"a").unwrap();
        assert!(edit(&mut db,QueueEdit::Detach{chain_id:"ch".into(),work_id:"a".into(),new_chain_id:"new".into()}).is_err());
        edit(&mut db,QueueEdit::Delete{chain_id:"ch".into(),work_id:"a".into()}).unwrap();
        let after=read_work(&db,"a").unwrap();
        assert_eq!(after["run_state"],before["run_state"]); assert_eq!(after["result_reported_at"],before["result_reported_at"]);
    }
}
// test-category: pure-logic
#[test]
fn queue_admission_requires_idle() {
    for state in RunState::ALL.iter().filter(|s| **s != RunState::Idle) {
        for root in [true,false] {
            let mut db=db(); queue(&mut db,&["a"]); work(&mut db,"w");
            db.execute("UPDATE wm_works SET run_state=?1,hold_reason=CASE WHEN ?1='held' THEN 'predecessor_failed' END,held_by_work_id=CASE WHEN ?1='held' THEN 'a' END WHERE id='w'",[state.as_str()]).unwrap();
            let tx=db.transaction().unwrap();
            let result=if root {create_root(&tx,&context(),"w",0,"new","chat",QueueOrigin::Detach,None)} else {place_after(&tx,&context(),"w",0,"a",graph(&tx,"ch"))};
            assert!(result.is_err(),"{state:?} root={root}");
        }
    }
}
// test-category: pure-logic
#[test]
fn last_failure_needs_no_question_and_crash_needs_no_caller_id() {
    let mut db=db(); queue(&mut db,&["a"]); runtime(&mut db,"a",RunState::Failed,false);
    assert!(undecided_holds(&db,"ch").unwrap().is_empty());
    assert_eq!(db.query_row::<String,_,_>("SELECT state FROM wm_work_chains WHERE id='ch'",[],|r|r.get(0)).unwrap(),"active");
}
// test-category: pure-logic
#[test]
fn crash_generates_question_without_supplied_ids() {
    let mut db=db(); queue(&mut db,&["a","b"]); runtime(&mut db,"a",RunState::Running,false);
    db.execute_batch("INSERT INTO wm_tasks(id,work_id,spec_ref,title,kind,status,task_rank,created_at,updated_at,created_by) VALUES('t','a','{}','t','execute','running','V',0,0,'{}'); INSERT INTO wm_attempts(id,task_id,task_revision,spec_ref,session_id,lease_epoch,status,started_at) VALUES('at','t',0,'{}','chat',1,'running',0);").unwrap();
    let tx=db.transaction().unwrap();
    recover_session(&tx,&context(),"chat",PreviousShutdown::Crash,&std::collections::BTreeMap::new()).unwrap();
    assert_eq!(undecided_holds(&tx,"ch").unwrap().len(),1);
}
// test-category: pure-logic
#[test]
fn generated_entropy_has_no_fixed_uuid_version_nibble() {
    use butler_work::work_ids::{IdGenerator,IdKind};
    let alphabet=b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut nibbles=std::collections::BTreeSet::new();
    for i in 0..512 {
        let id=IdGenerator::global_next(IdKind::Work,1_000_000+i).unwrap();
        let bits=id[3..].bytes().fold(0u128,|v,c| (v<<5)|alphabet.iter().position(|x|*x==c).unwrap() as u128);
        nibbles.insert((bits>>76)&15);
    }
    assert_eq!(nibbles.len(),16);
}
