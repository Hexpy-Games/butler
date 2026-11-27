//! Project Work replacing the same session's open session Work.
use super::*;
use butler_turn::btcc::{
    DurableWorkStatus, ProjectWorkLocateInput, ProjectWorkRuntimeProjection, SessionWorkRepository,
};

pub(crate) async fn project_work_replaces_an_open_session_work() {
    let mut h = Harness::new("work-session-switch");
    h.init().await;
    let fixture = TestStorageFixture::activated();
    let runtime = runtime(&fixture).await;
    let config = fixture.config("ledger-wire-formats-session");
    rusqlite::Connection::open(&config.path)
        .unwrap()
        .execute(
            "UPDATE btcc_turns SET execution_fence=0 WHERE turn_id=?1",
            ["turn-1"],
        )
        .unwrap();
    let storage = BtccStorage::open(config).await.unwrap();
    let session_repo = SessionWorkRepository::new(
        storage.clone(),
        Arc::new(|| "2026-01-02T03:04:05.000Z".to_owned()),
    );
    let mut command = start_command("turn-1", "start-session", "Research");
    command.input.scope.project_ref = None;
    let session_id = command.input.scope.session_id.clone();
    let old = session_repo.start_work(command).await.unwrap();

    let work = ProjectWork::new(
        h.ledger.clone(),
        runtime.clone(),
        runtime.clone(),
        runtime.clone(),
    );
    let repo = work.repository(h.scope());
    let started = repo
        .start_work(start_command("turn-2", "start-project", "Ship the feature"))
        .await
        .unwrap();
    let located = runtime
        .locate_canonical_works(ProjectWorkLocateInput {
            scope: h.scope(),
            session_id: Some(session_id),
            turn_id: None,
        })
        .await
        .unwrap();
    assert_eq!(located.session_head_work_id, Some(started.work_id));
    let old = session_repo
        .work_for_turn("turn-1".into(), old.work_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(old.status, DurableWorkStatus::Abandoned);

    work.close().await;
    h.ledger.close().await;
    storage.close().await.unwrap();
}
