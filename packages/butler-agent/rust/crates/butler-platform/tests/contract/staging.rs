//! Process lifetime and shutdown cleanup contracts for private reader copies.
use super::{fs, scratch};
use butler_platform::secure_fs::{self, StageScope, StagedFiles};

// test-category: security
#[test]
#[cfg(unix)]
fn startup_removes_stale_copies_without_following_links() {
    let temp = scratch("staging-startup");
    let data = temp.join("data");
    let outside = temp.join("outside");
    let base = data.join(butler_platform::data_paths::READER_STAGING);
    fs::create_dir_all(base.join("stale")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "untouched").unwrap();
    fs::write(base.join("stale/copy"), "private copy").unwrap();
    secure_fs::symlink(&outside, &base.join("alias")).unwrap();
    secure_fs::reset_reader_staging(&data).unwrap();
    assert!(!base.exists());
    secure_fs::symlink(&outside, &base).unwrap();
    secure_fs::reset_reader_staging(&data).unwrap();
    assert!(!base.exists());
    assert_eq!(
        fs::read_to_string(outside.join("keep")).unwrap(),
        "untouched"
    );
    fs::remove_dir_all(temp).unwrap();
}

// test-category: security
#[test]
fn rejected_blocking_cleanup_still_removes_owned_stages() {
    let temp = scratch("staging-shutdown");
    let source = temp.join("source");
    fs::write(&source, "complete").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let handle = runtime.handle().clone();
    runtime.shutdown_background();
    let _entered = handle.enter();
    for scoped in [false, true] {
        let scope = StageScope::new(&temp, "turn");
        let path = secure_fs::stage_file(
            &temp,
            "turn",
            &source,
            fs::File::open(&source).unwrap(),
            1024,
        )
        .unwrap();
        if !scoped {
            let mut files = StagedFiles::new(&temp);
            files.push(path.clone());
            drop(files);
        }
        drop(scope);
        assert!(!path.exists(), "rejected cleanup must run synchronously");
    }
    fs::remove_dir_all(temp).unwrap();
}
