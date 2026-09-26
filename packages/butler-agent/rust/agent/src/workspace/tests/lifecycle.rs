use super::*;

#[tokio::test]
async fn close_survives_cancelled_operation_observers() {
    let path = test_path("cancelled-close");
    let store = open(path.clone()).await;
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let operation_store = store.clone();
    let operation = tokio::spawn(async move {
        operation_store
            .execute(move |_| {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                Ok(())
            })
            .await
    });
    started_rx.await.unwrap();
    operation.abort();
    let first_close = tokio::spawn({
        let store = store.clone();
        async move { store.close().await }
    });
    tokio::task::yield_now().await;
    first_close.abort();
    release_tx.send(()).unwrap();
    store.close().await.unwrap();
    let _ignored = std::fs::remove_file(path);
}
