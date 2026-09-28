//! Process trees: group signals reach every descendant; liveness.

use butler_platform::process_control::{
    CONTAINS_PROCESS_TREES, GroupSignal, Liveness, SignalError, isolate_group, liveness,
    signal_group, terminating_signal,
};

use super::{REPORT, eventually, helper_command, read_report, scratch};

#[test]
fn group_signals_stop_every_descendant_of_an_isolated_command() {
    assert_eq!(CONTAINS_PROCESS_TREES, !cfg!(windows));
    for signal in [GroupSignal::Terminate, GroupSignal::Kill] {
        let report = scratch("tree").join("report");
        let mut command = helper_command("tree");
        command.env(REPORT, &report);
        isolate_group(&mut command);
        let mut leader = command.spawn().unwrap();
        let grandchild: u32 = read_report(&report).parse().unwrap();
        if !CONTAINS_PROCESS_TREES {
            assert!(matches!(
                signal_group(leader.id(), signal),
                Err(SignalError::Unsupported)
            ));
            leader.kill().unwrap();
            leader.wait().unwrap();
            continue;
        }
        assert_eq!(liveness(grandchild), Liveness::Running);
        signal_group(leader.id(), signal).unwrap();
        let status = leader.wait().unwrap();
        let expected = if signal == GroupSignal::Kill { 9 } else { 15 };
        assert_eq!(terminating_signal(status), Some(expected));
        // The orphaned grandchild is reaped by its new parent once stopped.
        eventually("the grandchild to be gone", || {
            liveness(grandchild) == Liveness::Gone
        });
    }
}

#[test]
fn a_group_that_no_longer_exists_is_already_stopped() {
    let mut command = helper_command("exit");
    isolate_group(&mut command);
    let mut leader = command.spawn().unwrap();
    let pid = leader.id();
    leader.wait().unwrap();
    if cfg!(windows) {
        assert!(matches!(
            signal_group(pid, GroupSignal::Kill),
            Err(SignalError::Unsupported)
        ));
        assert_eq!(liveness(pid), Liveness::Unknown);
    } else {
        signal_group(pid, GroupSignal::Kill).unwrap();
        assert_eq!(liveness(pid), Liveness::Gone);
    }
}

#[test]
fn liveness_distinguishes_running_and_absent_processes() {
    if cfg!(windows) {
        assert_eq!(liveness(std::process::id()), Liveness::Unknown);
        return;
    }
    assert_eq!(liveness(std::process::id()), Liveness::Running);
    // Ids that name no single process: 0 addresses a process group.
    for pid in [0, u32::MAX] {
        assert_eq!(liveness(pid), Liveness::Gone);
    }
}

/// A group whose members all exited but are not reaped yet is stopped:
/// Darwin answers `killpg` with EPERM for it, which must not fail.
#[cfg(unix)]
#[test]
fn a_group_of_only_zombies_is_already_stopped() {
    let mut command = helper_command("exit");
    isolate_group(&mut command);
    let mut leader = command.spawn().unwrap();
    let pid = leader.id();
    // Not reaped: the exited leader stays a zombie of this process.
    eventually("the unreaped leader to exit", || zombie(pid));
    #[cfg(target_os = "macos")]
    assert_eq!(
        nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
            nix::sys::signal::Signal::SIGKILL
        ),
        Err(nix::errno::Errno::EPERM)
    );
    signal_group(pid, GroupSignal::Kill).unwrap();
    leader.wait().unwrap();
}

/// Darwin keeps zombies out of `proc_pidinfo`; Linux reports state `Z`.
#[cfg(target_os = "macos")]
fn zombie(pid: u32) -> bool {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;
    pidinfo::<BSDInfo>(i32::try_from(pid).unwrap(), 0).is_err()
}

#[cfg(target_os = "linux")]
fn zombie(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit_once(')')
            .and_then(|(_, tail)| tail.split_whitespace().next())
            == Some("Z")
    })
}
