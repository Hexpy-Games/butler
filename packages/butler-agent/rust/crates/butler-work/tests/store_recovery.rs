#![allow(clippy::unwrap_used, reason = "test assertions")]
mod store_support;
use butler_work::{store::*, work_types::*};
use store_support::*;
// test-category: pure-logic
#[test]
fn clean_restart_resumes_same_step_and_crash_fails_tasks_and_holds_full_queue_once() {
    for (previous, step) in [
        (PreviousShutdown::Clean, 0),
        (PreviousShutdown::Crash, 0),
        (PreviousShutdown::Clean, 1),
        (PreviousShutdown::Crash, 1),
    ] {
        let mut db = db();
        queue(&mut db, &["a", "b", "c"]);
        let id = if step == 0 {
            "a"
        } else {
            runtime(&mut db, "a", TaskStatus::Completed, true);
            "b"
        };
        runtime(&mut db, id, TaskStatus::Running, false);
        db.execute("INSERT INTO wm_task_parts(id,task_id,kind,title,status,part_rank) VALUES('part',?1,'execute','part','running','A')",[id]).unwrap();
        db.execute("INSERT INTO wm_attempts(id,task_id,part_id,task_revision,spec_ref,session_id,lease_epoch,status,started_at) VALUES('at',?1,'part',1,'{}','chat',1,'interrupted',0)",[id]).unwrap();
        let tx = Transaction::new(db.transaction().unwrap()).unwrap();
        recover_session(&tx, &context(), "chat", previous).unwrap();
        let a = read_task(&tx, id).unwrap();
        assert_eq!(a["step_index"], step);
        assert_eq!(
            tx.query_row::<String, _, _>(
                "SELECT status FROM wm_task_parts WHERE id='part'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            if previous == PreviousShutdown::Clean {
                "pending"
            } else {
                "failed"
            }
        );
        assert_eq!(
            a["status"],
            if previous == PreviousShutdown::Clean {
                "pending"
            } else {
                "failed"
            }
        );
        assert_eq!(
            undecided_holds(&tx, "ch").unwrap().len(),
            usize::from(previous == PreviousShutdown::Crash)
        );
        if previous == PreviousShutdown::Crash {
            assert_eq!(a["failure_reason"], "interrupted_by_crash");
            assert_eq!(read_task(&tx, "c").unwrap()["status"], "held");
        }
        recover_session(&tx, &context(), "chat", PreviousShutdown::Crash).unwrap();
        assert_eq!(read_task(&tx, id).unwrap(), a);
        assert_eq!(load_chain(&tx, "ch").unwrap().chain.steps.len(), 3);
    }
}
