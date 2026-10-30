use super::*;

/// Extend the real grant/revocation race with committed reader isolation.
pub(super) async fn committed_reads(
    storage: &BtccStorage,
    authority: &PrincipalAuthority,
    request_ref: &str,
) {
    let request_ref = request_ref.to_owned();
    let grants = authority.list_all_permissions().await.unwrap();
    assert_eq!(grants.len(), 1);
    let permissions = authority.list_permissions("session".into()).await.unwrap();
    assert_eq!(permissions.len(), 1);

    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let writer = storage.clone();
    let job = tokio::spawn(async move {
        writer
            .execute(move |db| {
                let tx = db.transaction().map_err(StorageError::sqlite)?;
                tx.execute_batch(
                    "UPDATE btcc_turns SET original_message='latest committed message';
                UPDATE btcc_conversation_permissions SET revoked_at='later'",
                )
                .map_err(StorageError::sqlite)?;
                let _ = entered.send(());
                let _ = blocked.recv();
                tx.rollback().map_err(StorageError::sqlite)
            })
            .await
    });
    ready.await.unwrap();
    // The writer holds a real write transaction until all public reads finish.
    // Release and join the writer even on timeout; unwinding also drops `release`.
    let reads = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        for _ in 0..4 {
            assert_eq!(
                authority
                    .resume_source(request_ref.clone())
                    .await
                    .unwrap()
                    .unwrap()
                    .original_message,
                "hello"
            );
            assert_eq!(authority.list_decided().await.unwrap().len(), 1);
            assert_eq!(
                authority.waiting_source_sessions().await.unwrap(),
                ["session"]
            );
            assert!(
                authority
                    .retains_approval_claim("turn".into())
                    .await
                    .unwrap()
            );
            assert_eq!(
                format!("{:?}", authority.list_all_permissions().await.unwrap()),
                format!("{grants:?}")
            );
            assert_eq!(
                format!(
                    "{:?}",
                    authority.list_permissions("session".into()).await.unwrap()
                ),
                format!("{permissions:?}")
            );
            let pending = authority.list("session".into()).await.unwrap();
            assert_eq!(pending.len(), 0, "{pending:?}");
            assert_eq!(
                authority
                    .attention_owners(vec!["session".into()])
                    .await
                    .unwrap(),
                Vec::<(String, bool)>::new()
            );
        }
    })
    .await;
    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    reads.expect("authority reads must not queue behind the writer");
    // The held transaction rolled back; now commit a new source through the writer.
    storage
        .execute(|db| {
            db.execute(
                "UPDATE btcc_turns SET original_message='latest committed message'",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    // Reused readers must start a new snapshot after the acknowledged commit.
    for _ in 0..4 {
        assert_eq!(
            authority
                .resume_source(request_ref.clone())
                .await
                .unwrap()
                .unwrap()
                .original_message,
            "latest committed message"
        );
        assert_eq!(
            format!(
                "{:?}",
                authority.list_permissions("session".into()).await.unwrap()
            ),
            format!("{permissions:?}")
        );
        assert_eq!(
            format!("{:?}", authority.list_all_permissions().await.unwrap()),
            format!("{grants:?}")
        );
    }
}
