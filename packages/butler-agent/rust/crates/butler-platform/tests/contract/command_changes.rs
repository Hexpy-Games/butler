//! A command's change observation stays complete while another actor keeps
//! the watched root busy.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use butler_platform::command_sandbox::CommandChanges;

pub(super) fn busy_root_stays_complete() {
    let root = super::scratch("command-changes-busy");
    let changes = CommandChanges::watch(&root).unwrap();
    fs::write(root.join("own.txt"), "x").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let (stop, other) = (stop.clone(), root.join("other.txt"));
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let _ = fs::write(&other, "y");
            }
        })
    };
    let observed = changes.finish();
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();
    let _ = fs::remove_dir_all(&root);
    assert!(
        observed.complete,
        "a root another writer keeps busy was reported incomplete"
    );
    assert!(observed.paths.contains(&PathBuf::from("own.txt")));
}
