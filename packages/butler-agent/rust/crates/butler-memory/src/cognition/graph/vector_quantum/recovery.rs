//! Recovering vector units left running by a process that exited.

use super::*;

/// Returns running units whose owner is this process or no longer alive to
/// pending, and refreshes their jobs. Vectors come only from the local
/// deterministic model: an interrupted request, even one whose outcome is
/// unknown, is re-embedded at no cost but CPU and yields the same vector (the
/// store merges by key), so the interruption consumes no attempt.
pub(super) fn recover(connection: &Connection) -> CognitionResult<()> {
    let mut statement = connection
        .prepare("SELECT unit_id,job_id,owner_pid FROM memory_vector_units WHERE state='running'")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    let mut jobs = HashSet::new();
    for (id, job, pid) in rows {
        let abandoned =
            pid.is_none_or(|pid| pid == i64::from(std::process::id()) || !pid_alive(pid));
        if !abandoned {
            continue;
        }
        connection.execute("UPDATE memory_vector_units SET state='pending',attempt_count=MAX(0,attempt_count-1),error_code='memory_projection_interrupted',next_attempt_at=NULL,owner_pid=NULL,owner_nonce=NULL,started_at=NULL,provider_invoked=0,outcome_known=1,invocation_ref=NULL WHERE unit_id=?1 AND state='running'",params![id]).map_err(db_error)?;
        jobs.insert(job);
    }
    for job in jobs {
        refresh(
            connection,
            &job,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )?;
    }
    Ok(())
}

/// Whether the job owner may still run; a host that cannot tell keeps it.
/// Ids that name no single process are not owners.
pub(super) fn pid_alive(pid: i64) -> bool {
    use butler_platform::process_control::{Liveness, liveness};
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    matches!(
        liveness(pid),
        Liveness::Running | Liveness::OtherOwner | Liveness::Unknown
    )
}
