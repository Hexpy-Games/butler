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
