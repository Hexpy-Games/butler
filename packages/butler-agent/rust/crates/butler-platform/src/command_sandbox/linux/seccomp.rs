//! Socket allow-list and metadata mutations not mediated by Landlock.
use nix::libc;
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

use super::Error;

fn socketpair_denials() -> Result<Vec<SeccompRule>, Error> {
    // Only anonymous AF_UNIX streams: multiprocessing.Pipe and similar local
    // workers need duplex IPC. Connected streams cannot reconnect/sendto an
    // external peer. Datagram pairs can, so those are deliberately excluded.
    let types = [
        0,
        libc::SOCK_CLOEXEC,
        libc::SOCK_NONBLOCK,
        libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
    ]
    .into_iter()
    .map(|flags| -> Result<_, Error> {
        Ok(SeccompCondition::new(
            1,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Ne,
            u64::try_from(libc::SOCK_STREAM | flags)?,
        )?)
    })
    .collect::<Result<Vec<_>, _>>()?;
    Ok(vec![
        SeccompRule::new(vec![SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Ne,
            libc::AF_UNIX as u64,
        )?])?,
        SeccompRule::new(types)?,
        SeccompRule::new(vec![SeccompCondition::new(
            2,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Ne,
            0,
        )?])?,
    ])
}

pub(super) fn filter() -> Result<BpfProgram, Error> {
    let mut rules = metadata_syscalls()
        .into_iter()
        .map(|number| (number, vec![]))
        .collect::<Vec<_>>();
    // No socket() family is required for filesystem observations. In
    // particular, NETLINK is not read-only: it can mutate kernel state.
    rules.extend([
        (libc::SYS_socket, vec![]),
        // Anonymous pairs need no connect(). Deny it even on inherited fds.
        (libc::SYS_connect, vec![]),
        (libc::SYS_io_uring_setup, vec![]),
    ]);
    rules.push((libc::SYS_socketpair, socketpair_denials()?));
    #[cfg(all(target_arch = "x86_64", target_pointer_width = "64"))]
    {
        const X32_SYSCALL_BIT: i64 = 0x4000_0000;
        rules.extend(
            rules
                .clone()
                .into_iter()
                .map(|(number, conditions)| (number | X32_SYSCALL_BIT, conditions)),
        );
    }
    Ok(SeccompFilter::new(
        rules.into_iter().collect(),
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        std::env::consts::ARCH.try_into()?,
    )?
    .try_into()?)
}

fn metadata_syscalls() -> Vec<i64> {
    // Linux's generic syscall table assigns these since 6.5/6.13; libc does not
    // yet expose them on all supported targets. Filter them on older hosts too.
    const SETXATTRAT: i64 = 463;
    const REMOVEXATTRAT: i64 = 466;
    const FCHMODAT2: i64 = 452;
    let calls = [
        libc::SYS_fchmod,
        libc::SYS_fchmodat,
        FCHMODAT2,
        libc::SYS_fchown,
        libc::SYS_fchownat,
        libc::SYS_utimensat,
        libc::SYS_setxattr,
        libc::SYS_lsetxattr,
        libc::SYS_fsetxattr,
        libc::SYS_removexattr,
        libc::SYS_lremovexattr,
        libc::SYS_fremovexattr,
        SETXATTRAT,
        REMOVEXATTRAT,
    ];
    #[cfg(target_arch = "x86_64")]
    let legacy = [
        libc::SYS_chmod,
        libc::SYS_chown,
        libc::SYS_lchown,
        libc::SYS_utime,
        libc::SYS_utimes,
        libc::SYS_futimesat,
    ];
    #[cfg(not(target_arch = "x86_64"))]
    let legacy = [];
    calls.into_iter().chain(legacy).collect()
}

pub(super) fn apply() -> Result<(), Error> {
    seccompiler::apply_filter(&filter()?)?;
    Ok(())
}
