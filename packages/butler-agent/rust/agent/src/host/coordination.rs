//! Native Unix process probes for the shared Cognition writer coordinator.
//! Signal zero checks existence/permission and never delivers a signal.

use nix::errno::Errno;
use nix::sys::signal::kill;
use nix::unistd::{Pid, gethostname};

use crate::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CoordinationError, CoordinationResult,
};

use super::SystemIdentity;

impl CognitionCoordinationHost for SystemIdentity {
    fn process_id(&self) -> u32 {
        std::process::id()
    }

    fn hostname(&self) -> CoordinationResult<String> {
        gethostname()
            .map(|name| name.to_string_lossy().into_owned())
            .map_err(CoordinationError::gate_io)
    }

    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        // Never truncate a source safe-integer PID to another process, or use
        // zero/negative values that have process-group semantics on Unix.
        let Ok(pid) = i32::try_from(pid) else {
            return CognitionProcessStatus::Uncertain;
        };
        if pid <= 0 {
            return CognitionProcessStatus::Uncertain;
        }
        probe_result(kill(Pid::from_raw(pid), None))
    }

    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_epoch_millis(&self) -> i64 {
        crate::models::ModelConfigurationClock::now_epoch_millis(self)
    }

    fn now_iso(&self) -> String {
        super::iso_timestamp(std::time::SystemTime::now())
    }
}

fn probe_result(result: Result<(), Errno>) -> CognitionProcessStatus {
    match result {
        Ok(()) => CognitionProcessStatus::Alive,
        Err(Errno::ESRCH) => CognitionProcessStatus::DefinitelyDead,
        Err(_) => CognitionProcessStatus::Uncertain,
    }
}

pub(super) fn profile_process_status(pid: f64) -> CognitionProcessStatus {
    // Unlike the coordinator's validated positive PID, Profile receives a
    // persisted JS number. Node permits signed int32 PIDs (including signal-0
    // process-group probes); invalid numbers throw a non-ESRCH error.
    if !pid.is_finite()
        || pid.fract() != 0.0
        || pid < f64::from(i32::MIN)
        || pid > f64::from(i32::MAX)
    {
        return CognitionProcessStatus::Uncertain;
    }
    probe_result(kill(Pid::from_raw(crate::json::saturating_i32(pid)), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_probe_uses_current_pid_and_preserves_uncertainty() {
        let host = SystemIdentity;
        assert_eq!(host.process_id(), std::process::id());
        assert_eq!(
            host.process_status(u64::from(std::process::id())),
            CognitionProcessStatus::Alive
        );
        assert_eq!(host.process_status(0), CognitionProcessStatus::Uncertain);
        assert_eq!(
            host.process_status(9_007_199_254_740_991),
            CognitionProcessStatus::Uncertain
        );
        assert_eq!(
            probe_result(Err(Errno::EPERM)),
            CognitionProcessStatus::Uncertain
        );
        assert_eq!(
            probe_result(Err(Errno::ESRCH)),
            CognitionProcessStatus::DefinitelyDead
        );
        assert!(!host.hostname().unwrap().is_empty());
    }
}
