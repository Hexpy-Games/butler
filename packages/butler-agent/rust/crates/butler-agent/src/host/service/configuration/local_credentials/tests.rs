use super::*;
use std::sync::{Mutex, OnceLock, mpsc};

struct Delay {
    path: PathBuf,
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}
fn delay() -> &'static Mutex<Option<Delay>> {
    static DELAY: OnceLock<Mutex<Option<Delay>>> = OnceLock::new();
    DELAY.get_or_init(Mutex::default)
}
pub(super) fn before_replace(path: &Path) {
    let mut stored = delay().lock().unwrap();
    if stored.as_ref().is_some_and(|hook| hook.path == path) {
        let hook = stored.take().unwrap();
        drop(stored);
        hook.entered.send(()).unwrap();
        hook.release.recv().unwrap();
    }
}

// test-category: race
#[test]
fn concurrent_repair_keeps_the_first_published_credential() {
    let root =
        std::env::temp_dir().join(format!("butler-credential-race-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("credential");
    fs::write(&path, "unusable").unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *delay().lock().unwrap() = Some(Delay {
        path: path.clone(),
        entered: entered_tx,
        release: release_rx,
    });
    let first_path = path.clone();
    let first = std::thread::spawn(move || {
        load_file(&first_path, CredentialFiles::CreateMissing, usable, || {
            Ok(b"first".to_vec())
        })
        .unwrap()
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    // The delayed creator has already observed the unusable file. A second
    // creator publishes and returns its identity before the first resumes.
    let second = load_file(&path, CredentialFiles::CreateMissing, usable, || {
        Ok(b"second".to_vec())
    })
    .unwrap();
    release_tx.send(()).unwrap();
    let first = first.join().unwrap();
    let saved = read_usable(&path, usable).unwrap().unwrap();
    assert!(
        first == second && second == saved,
        "creators retained different credentials"
    );
    fs::remove_dir_all(root).unwrap();
}
fn usable(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    (text != "unusable").then(|| text.to_owned())
}
