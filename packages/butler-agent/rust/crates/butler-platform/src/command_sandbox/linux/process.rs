//! Keep descendants in the group the command owner stops before its sweep.
use super::Error;
use nix::libc;
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

pub(super) fn clone_denials() -> Result<Vec<SeccompRule>, Error> {
    [libc::CLONE_NEWUSER, libc::CLONE_NEWPID]
        .into_iter()
        .map(|flag| {
            let flag = u64::try_from(flag)?;
            Ok(SeccompRule::new(vec![SeccompCondition::new(
                0,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::MaskedEq(flag),
                flag,
            )?])?)
        })
        .collect()
}

pub(super) fn apply() -> Result<(), Error> {
    // clone3's flags live behind a pointer, beyond seccomp's argument checks.
    // Report it unavailable so ordinary libc threads/forks use legacy clone,
    // whose namespace flags are checked. EPERM would break that fallback.
    let calls = [
        (libc::SYS_clone3, vec![]),
        #[cfg(all(target_arch = "x86_64", target_pointer_width = "64"))]
        (libc::SYS_clone3 | 0x4000_0000, vec![]),
    ];
    let program: BpfProgram = SeccompFilter::new(
        calls.into_iter().collect(),
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
        std::env::consts::ARCH.try_into()?,
    )?
    .try_into()?;
    seccompiler::apply_filter(&program)?;
    Ok(())
}
