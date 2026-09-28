use std::{path::Path, sync::Arc, time::Duration};

use parking_lot::Mutex;
use tokio::{sync::mpsc, time::Instant};

use super::*;

type Emitted = Arc<Mutex<Vec<(Duration, Vec<String>)>>>;

fn recorder(start: Instant) -> (Emitted, ModulesChanged) {
    let emitted: Emitted = Arc::default();
    let log = emitted.clone();
    let changed: ModulesChanged = Arc::new(move |ids| {
        log.lock().push((start.elapsed(), ids));
        Box::pin(async {})
    });
    (emitted, changed)
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_changes_becomes_one_update_after_a_quiet_moment() {
    let start = Instant::now();
    let (emitted, changed) = recorder(start);
    let (sender, receiver) = mpsc::unbounded_channel();
    let task = tokio::spawn(debounce(receiver, changed));
    for (at, id) in [(0, "user.rain"), (100, "user.moss"), (200, "user.rain")] {
        tokio::time::sleep_until(start + Duration::from_millis(at)).await;
        sender.send(id.to_owned()).unwrap();
    }
    tokio::time::sleep_until(start + Duration::from_millis(200) + QUIET / 2).await;
    assert!(emitted.lock().is_empty());
    tokio::time::sleep_until(start + Duration::from_secs(5)).await;
    assert_eq!(
        *emitted.lock(),
        [(
            Duration::from_millis(200) + QUIET,
            vec!["user.moss".to_owned(), "user.rain".to_owned()]
        )]
    );

    // Steady changes still surface at least every LONGEST.
    emitted.lock().clear();
    let begin = Instant::now();
    for step in 0..40 {
        tokio::time::sleep_until(begin + Duration::from_millis(100 * step)).await;
        sender.send("user.fern".to_owned()).unwrap();
    }
    let first = emitted.lock().first().cloned().unwrap();
    assert_eq!(first.1, ["user.fern"]);
    assert!(
        first.0 - (begin - start) <= LONGEST + Duration::from_millis(1),
        "{first:?}"
    );
    drop(sender);
    task.await.unwrap();
}

#[test]
fn a_change_names_the_module_folder_it_happened_in() {
    let root = Path::new("/data/wallpapers");
    for (path, expected) in [
        ("/data/wallpapers/user.rain/shader.frag", Some("user.rain")),
        ("/data/wallpapers/user.rain", Some("user.rain")),
        ("/data/wallpapers/user.rain/sub/x", Some("user.rain")),
        ("/data/wallpapers/.import-1/shader.frag", None),
        ("/data/wallpapers/.DS_Store", None),
        ("/data/wallpapers", None),
        ("/data/other/user.rain", None),
    ] {
        assert_eq!(folder(root, Path::new(path)).as_deref(), expected, "{path}");
    }
}

#[tokio::test]
async fn the_watcher_reports_written_module_files() {
    let root = crate::gateway::wallpaper_modules::user::tests::root("watch");
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let changed: ModulesChanged = Arc::new(move |ids| {
        let _ = sender.send(ids);
        Box::pin(async {})
    });
    let watcher = watch(&root, changed).unwrap();
    let folder = root.join("user.rain");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("shader.frag"), "void main(){}").unwrap();
    let ids = tokio::time::timeout(Duration::from_secs(10), receiver.recv())
        .await
        .expect("a module change is reported")
        .unwrap();
    assert_eq!(ids, ["user.rain"]);
    drop(watcher);
    std::fs::remove_dir_all(root).unwrap();
}
