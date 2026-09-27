use super::*;

#[tokio::test]
async fn failure_and_success_both_suppress_same_local_day() {
    let root = std::env::temp_dir().join(format!("butler-daily-schedule-{}", uuid::Uuid::new_v4()));
    let cancellation = CancellationToken::new();
    assert!(
        !run_due(
            &root,
            "session-sync",
            "2026-09-23",
            239,
            0,
            &cancellation,
            async { panic!("before due time") }
        )
        .await
        .unwrap()
    );
    assert_eq!(
        run_due(
            &root,
            "session-sync",
            "2026-09-23",
            240,
            0,
            &cancellation,
            async { Err("failed".into()) }
        )
        .await
        .unwrap_err(),
        "failed"
    );
    assert!(
        run_due(
            &root,
            "consolidation-cycle",
            "2026-09-23",
            240,
            0,
            &cancellation,
            async { Ok(()) }
        )
        .await
        .unwrap()
    );
    assert!(
        !run_due(
            &root,
            "session-sync",
            "2026-09-23",
            240,
            0,
            &cancellation,
            async { panic!("same day already attempted") }
        )
        .await
        .unwrap()
    );
    assert!(
        run_due(
            &root,
            "session-sync",
            "2026-09-24",
            240,
            0,
            &cancellation,
            async { Ok(()) }
        )
        .await
        .unwrap()
    );
    assert!(
        !run_due(
            &root,
            "session-sync",
            "2026-09-24",
            240,
            0,
            &cancellation,
            async { panic!("same day already attempted") }
        )
        .await
        .unwrap()
    );
    let closing = CancellationToken::new();
    closing.cancel();
    assert!(
        !run_due(
            &root,
            "consolidation-cycle",
            "2026-09-24",
            240,
            0,
            &closing,
            async { panic!("closed scheduler admitted work") }
        )
        .await
        .unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}
