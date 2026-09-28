use super::{executable_matches, process_executable, process_start_identity};

#[test]
fn current_process_has_stable_kernel_identity_and_executable() {
    let pid = std::process::id();
    let first_start = process_start_identity(pid)
        .expect("current process identity is available")
        .expect("current process is present");
    let second_start = process_start_identity(pid)
        .expect("current process identity is available")
        .expect("current process is present");
    let executable = process_executable(pid)
        .expect("current process executable is available")
        .expect("current process is present");

    assert_eq!(first_start, second_start);
    assert!(executable_matches(&executable, &executable));
    assert!(!executable_matches(&executable, "/a/different/executable"));
}

/// macOS names a hard-linked executable by its most recent lookup, so the
/// identity check compares files, not spellings: another link of the same
/// file matches, a copy does not.
#[test]
fn executable_identity_is_the_file_not_its_name() {
    let dir = std::env::temp_dir().join(format!(
        "butler-instance-identity-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&dir).expect("temporary directory is created");
    let original = dir.join("butler-agent");
    let link = dir.join("butler-agent-link");
    let copy = dir.join("butler-agent-copy");
    std::fs::write(&original, b"agent").expect("executable is written");
    std::fs::hard_link(&original, &link).expect("hard link is created");
    std::fs::copy(&original, &copy).expect("copy is created");
    let [original, link, copy] =
        [&original, &link, &copy].map(|path| path.to_string_lossy().into_owned());

    assert!(executable_matches(&original, &link));
    assert!(executable_matches(&link, &original));
    assert!(!executable_matches(&original, &copy));
    assert!(!executable_matches(
        &original,
        &format!("{original}-missing")
    ));
    let _ = std::fs::remove_dir_all(&dir);
}
