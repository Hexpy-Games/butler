//! Socket allow-list and metadata mutations not mediated by Landlock.
use nix::libc;
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

use super::Error;

fn socketpair_denials() -> Result<Vec<SeccompRule>, Error> {
    // Only anonymous connected AF_UNIX pairs: multiprocessing.Pipe and similar
    // local workers need duplex IPC, and Rust's process spawning (Cargo) passes
    // a pidfd over a SEQPACKET pair. Connected stream/seqpacket sockets ignore
    // a sendto address and cannot reconnect (connect is denied). Datagram
    // pairs can address an external peer, so those are deliberately excluded.
    let flags = [
        0,
        libc::SOCK_CLOEXEC,
        libc::SOCK_NONBLOCK,
        libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
    ];
    let types = [libc::SOCK_STREAM, libc::SOCK_SEQPACKET]
        .into_iter()
        .flat_map(|kind| flags.map(|flags| kind | flags))
        .map(|kind| -> Result<_, Error> {
            Ok(SeccompCondition::new(
                1,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                u64::try_from(kind)?,
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

fn ioctl_denials() -> Result<Vec<SeccompRule>, Error> {
    // These generic kernel requests change only the calling process's fd
    // close-on-exec/nonblocking flags, never file metadata or device state.
    // In particular, stream IPC needs FIONBIO to select blocking behavior.
    let conditions = [libc::FIOCLEX, libc::FIONCLEX, libc::FIONBIO]
        .into_iter()
        .map(|request| -> Result<_, Error> {
            Ok(SeccompCondition::new(
                1,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                u64::from(u32::try_from(request)?),
            )?)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(vec![SeccompRule::new(conditions)?])
}

/// `metadata` allows chmod/chown/utimes/xattr calls. Landlock does not
/// mediate them, so only a namespace whose mounts outside the writable roots
/// are all read-only (M+) may allow them; the VFS then refuses them there.
pub(super) fn filter(metadata: bool) -> Result<BpfProgram, Error> {
    let ioctl = ioctl_denials()?;
    let mut rules = if metadata {
        Vec::new()
    } else {
        metadata_syscalls()
            .into_iter()
            .map(|number| (number, vec![]))
            .collect::<Vec<_>>()
    };
    // No socket() family is required for filesystem observations. In
    // particular, NETLINK is not read-only: it can mutate kernel state.
    rules.extend([
        (libc::SYS_setsid, vec![]),
        (libc::SYS_setpgid, vec![]),
        (libc::SYS_unshare, vec![]),
        (libc::SYS_setns, vec![]),
        (libc::SYS_mount, vec![]),
        (libc::SYS_umount2, vec![]),
        (libc::SYS_move_mount, vec![]),
        (libc::SYS_open_tree, vec![]),
        (libc::SYS_fsopen, vec![]),
        (libc::SYS_fsconfig, vec![]),
        (libc::SYS_fspick, vec![]),
        (libc::SYS_fsmount, vec![]),
        (libc::SYS_mount_setattr, vec![]),
        (libc::SYS_pivot_root, vec![]),
        (libc::SYS_chroot, vec![]),
        (libc::SYS_clone, super::process::clone_denials()?),
        (libc::SYS_socket, vec![]),
        // Anonymous pairs need no connect(). Deny it even on inherited fds.
        (libc::SYS_connect, vec![]),
        (libc::SYS_io_uring_setup, vec![]),
        // Landlock's device right does not cover filesystem ioctls that alter
        // regular-file metadata. Deny driver/filesystem commands while
        // allowing only local descriptor flags needed by ordinary IPC.
        (libc::SYS_ioctl, ioctl.clone()),
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
        // x32 ioctl has a distinct compat entry, beyond the common table.
        const X32_IOCTL: i64 = 514;
        rules.push((X32_IOCTL | X32_SYSCALL_BIT, ioctl));
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

pub(super) fn apply(metadata: bool) -> Result<(), Error> {
    super::process::apply()?;
    seccompiler::apply_filter(&filter(metadata)?)?;
    Ok(())
}
