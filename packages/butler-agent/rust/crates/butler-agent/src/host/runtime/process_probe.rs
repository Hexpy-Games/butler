//! Process probes for the shared Cognition writer coordinator, through
//! `butler_platform`: a signal-zero style probe checks existence and
//! permission and never delivers anything.

use butler_platform::instance::host_name;
use butler_platform::process_control::{Liveness, target_liveness};

use butler_memory::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CoordinationError, CoordinationResult,
};

use crate::host::SystemIdentity;

impl CognitionCoordinationHost for SystemIdentity {
    fn process_id(&self) -> u32 {
        std::process::id()
    }

    fn hostname(&self) -> CoordinationResult<String> {
        host_name().map_err(CoordinationError::gate_io)
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
        probe_status(target_liveness(pid))
    }

    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_epoch_millis(&self) -> i64 {
        butler_models::models::ModelConfigurationClock::now_epoch_millis(self)
    }

    fn now_iso(&self) -> String {
        butler_core::js_date::iso_from_system_time(std::time::SystemTime::now())
    }
}

/// Only a process that is certainly gone is dead: one owned by another user,
/// or a probe the host could not answer, stays uncertain.
fn probe_status(liveness: Liveness) -> CognitionProcessStatus {
    match liveness {
        Liveness::Running => CognitionProcessStatus::Alive,
        Liveness::Gone => CognitionProcessStatus::DefinitelyDead,
        Liveness::OtherOwner | Liveness::Unknown => CognitionProcessStatus::Uncertain,
    }
}

pub(in crate::host) fn profile_process_status(pid: f64) -> CognitionProcessStatus {
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
    probe_status(target_liveness(butler_core::json::saturating_i32(pid)))
}
