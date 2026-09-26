//! A dropped caller cannot discard a pinned blocking read or shortcut close.

use std::{
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio::sync::oneshot;

use crate::cognition::{CognitionPathEnvironment, NativeMemoryRecall, RecallRequest};

pub(super) async fn prove(data_root: PathBuf, request: RecallRequest) {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered_tx, entered_rx) = oneshot::channel::<()>();
    let sender = Arc::new(Mutex::new(Some(entered_tx)));
    let calls = Arc::new(AtomicUsize::new(0));
    let clock = {
        let gate = gate.clone();
        let sender = sender.clone();
        let calls = calls.clone();
        Arc::new(move || {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(());
                }
                let (mutex, signal) = &*gate;
                let mut released = mutex.lock().unwrap();
                while !*released {
                    released = signal.wait(released).unwrap();
                }
            }
            crate::js_date::parse_iso_millis("2026-09-19T00:00:00.000Z").unwrap()
        })
    };
    let reader = Arc::new(NativeMemoryRecall::new(
        data_root,
        CognitionPathEnvironment::default(),
        Arc::new(crate::js_date::parse_iso_millis),
        Arc::new(|left: &str, right: &str| left.cmp(right)),
        clock,
        1,
    ));
    let caller = {
        let reader = reader.clone();
        tokio::spawn(async move { reader.recall(request).await })
    };
    let entered = tokio::time::timeout(Duration::from_secs(2), entered_rx).await;
    caller.abort();
    let mut closing = {
        let reader = reader.clone();
        tokio::spawn(async move { reader.close().await })
    };
    let held = tokio::time::timeout(Duration::from_millis(50), &mut closing)
        .await
        .is_err();
    {
        let (mutex, signal) = &*gate;
        *mutex.lock().unwrap() = true;
        signal.notify_all();
    }
    assert!(
        entered.is_ok(),
        "read should own its graph before the caller disappears"
    );
    assert!(held, "close must wait for the pinned read");
    tokio::time::timeout(Duration::from_secs(2), closing)
        .await
        .unwrap()
        .unwrap();
}
