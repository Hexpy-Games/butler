//! Deny new external sockets and the io_uring socket bypass. Local socketpair
//! and AF_NETLINK remain available to shells and host discovery commands.
use nix::libc;
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

pub(super) fn filter() -> Result<BpfProgram, Box<dyn std::error::Error>> {
    let sockets = [
        libc::AF_INET,
        libc::AF_INET6,
        libc::AF_PACKET,
        libc::AF_UNIX,
    ]
    .into_iter()
    .map(|family| -> Result<_, Box<dyn std::error::Error>> {
        Ok(SeccompRule::new(vec![SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Eq,
            u64::try_from(family)?,
        )?])?)
    })
    .collect::<Result<Vec<_>, _>>()?;
    let rules = vec![
        (libc::SYS_socket, sockets.clone()),
        (libc::SYS_io_uring_setup, vec![]),
    ];
    // x32 shares AUDIT_ARCH_X86_64, but adds this bit to syscall numbers.
    // Filter both encodings so a compat socket cannot bypass native rules.
    #[cfg(all(target_arch = "x86_64", target_pointer_width = "64"))]
    let rules = {
        let mut rules = rules;
        const X32_SYSCALL_BIT: i64 = 0x4000_0000;
        rules.push((libc::SYS_socket + X32_SYSCALL_BIT, sockets));
        rules.push((libc::SYS_io_uring_setup + X32_SYSCALL_BIT, vec![]));
        rules
    };
    Ok(SeccompFilter::new(
        rules.into_iter().collect(),
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        std::env::consts::ARCH.try_into()?,
    )?
    .try_into()?)
}

pub(super) fn apply() -> Result<(), Box<dyn std::error::Error>> {
    seccompiler::apply_filter(&filter()?)?;
    Ok(())
}
