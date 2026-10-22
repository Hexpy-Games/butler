//! Tier admission is part of the ordinary Work batch, never a classifier call.
//! Permission/access admission remains the effect owner's responsibility.
use super::execution::revision;
use super::*;
use rusqlite::params;

pub const POLICY_REVISION: &str = "work-model-tiers-1";
pub mod sql {
    pub const FLOOR_COUNT: &str = "SELECT count(*) FROM (SELECT 1 FROM wm_tasks WHERE work_id=?1 AND status<'cancelled' UNION ALL SELECT 1 FROM wm_tasks WHERE work_id=?1 AND status>'cancelled' LIMIT 6)";
    pub const SESSION: &str = "SELECT * FROM wm_session_exec WHERE session_id=?1";
    pub const SET_TIER: &str = "INSERT INTO wm_session_exec(session_id,tier,phase,control_state,control_epoch,last_applied_seq,tier_reason,tier_policy_revision) VALUES(?1,?2,'execution','running',0,0,?3,?4) ON CONFLICT(session_id) DO UPDATE SET tier=excluded.tier,tier_reason=excluded.tier_reason,tier_policy_revision=excluded.tier_policy_revision";
    pub const WORK_TIER: &str =
        "UPDATE wm_works SET tier=?2,revision=revision+(tier<>?2),updated_at=?3 WHERE id=?1";
    pub const ACTIVE_LEASE: &str = "SELECT a.id FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.task_id=?1 AND a.session_id=?2 AND a.status='running' AND a.part_id IS NULL AND t.status IN ('running','in_review')";
    pub const ACTIVE_PART_LEASE: &str = "SELECT a.id FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.session_id=?2 AND a.task_id=?1 AND a.status='running' AND a.part_id IS NOT NULL AND t.status IN ('running','in_review') LIMIT 1";
    pub const BIND_TASK: &str = "UPDATE wm_session_exec SET current_task_id=?2 WHERE session_id=?1";
    pub const UNCOVERED: &str = "SELECT c.criterion_id FROM wm_spec_nodes n JOIN wm_spec_criteria c ON c.node_id=n.node_id AND c.revision=n.active_revision WHERE n.work_id=?1 AND NOT EXISTS(SELECT 1 FROM wm_task_criteria b JOIN wm_tasks t ON t.id=b.task_id WHERE b.node_id=c.node_id AND b.node_revision=c.revision AND b.criterion_id=c.criterion_id AND t.work_id=?1 AND t.status!='cancelled') LIMIT 1";
    pub const DETAIL: &str = "SELECT node_id FROM wm_spec_nodes WHERE work_id=?1 AND parent_node_id IS NOT NULL AND active_revision IS NOT NULL LIMIT 1";
    pub const ALL: &[(&str, &str)] = &[
        ("FLOOR_COUNT", FLOOR_COUNT),
        ("SESSION", SESSION),
        ("SET_TIER", SET_TIER),
        ("DETAIL", DETAIL),
        ("UNCOVERED", UNCOVERED),
        ("WORK_TIER", WORK_TIER),
        ("ACTIVE_LEASE", ACTIVE_LEASE),
        ("ACTIVE_PART_LEASE", ACTIVE_PART_LEASE),
        ("BIND_TASK", BIND_TASK),
    ];
}

/// Facts from structured admission boundaries, rather than guessed keywords.
#[derive(Debug, Clone, Copy, Default)]
pub struct Floors {
    pub requested_analysis_or_report: bool,
    pub delegation_or_child_assignment: bool,
    pub planned_resumable_or_scheduled: bool,
}
impl Floors {
    pub fn requires_full(self) -> bool {
        self.requested_analysis_or_report
            || self.delegation_or_child_assignment
            || self.planned_resumable_or_scheduled
    }
}

pub fn check_floor(
    db: &Connection,
    work: Option<&str>,
    tier: u8,
    added: usize,
    facts: Floors,
) -> Result<()> {
    if tier >= 2 {
        return Ok(());
    }
    let count: i64 = match work {
        Some(id) => db.query_row(sql::FLOOR_COUNT, [id], |r| r.get(0))?,
        None => 0,
    };
    if tier < 2
        && (facts.requires_full()
            || count.saturating_add(i64::try_from(added).unwrap_or(i64::MAX)) > 5)
    {
        return Err(Error::Invalid(
            "Tier 2 required: escalate, publish Spec detail, and retry in this round; preserve the existing Work and Task identities",
        ));
    }
    Ok(())
}

/// Only a successful managed batch records tier; direct turns call no writer.
pub fn admit(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    work: &str,
    tier: u8,
    reason: &str,
) -> Result<()> {
    if !(1..=2).contains(&tier) || reason.trim().is_empty() || session.is_empty() {
        return Err(Error::Invalid("managed tier and reason required"));
    }
    let row = read_work(tx, work)?;
    if row["tier"]
        .as_u64()
        .is_some_and(|old| old > u64::from(tier))
    {
        return Err(Error::Invalid("tier escalation is upward only"));
    }
    tx.execute(sql::WORK_TIER, params![work, tier, ctx.now])?;
    tx.execute(
        sql::SET_TIER,
        params![session, tier, reason, POLICY_REVISION],
    )?;
    event(
        tx,
        ctx,
        "work",
        work,
        revision(&read_work(tx, work)?)?,
        "tier_admitted",
    )
}

pub fn bind_started_task(tx: &Transaction<'_>, session: &str, task: &str) -> Result<()> {
    tx.execute(sql::BIND_TASK, params![session, task])?;
    Ok(())
}

/// A managed session needs its own live Task lease before file/command effects.
/// Tier 0 has no execution row and retains the normal permission checks.
pub fn effects_allowed(db: &Connection, session: &str) -> Result<bool> {
    let row = match one(db, sql::SESSION, [session]) {
        Ok(row) => row,
        Err(Error::NotFound) => {
            return Ok(super::bound_work(db, session, None)?.is_none());
        }
        Err(error) => return Err(error),
    };
    if row["tier"] == 0 {
        return Ok(true);
    }
    if row["control_state"] != "running" {
        return Ok(false);
    }
    let Some(task) = row["current_task_id"].as_str() else {
        return Ok(false);
    };
    match one(db, sql::ACTIVE_LEASE, params![task, session]).or_else(|error| match error {
        Error::NotFound => one(db, sql::ACTIVE_PART_LEASE, params![task, session]),
        other => Err(other),
    }) {
        Ok(_) => match execution::ensure_task_effect(db, task, session) {
            Ok(_) => Ok(true),
            Err(Error::Invalid(_) | Error::NotFound | Error::Running) => Ok(false),
            Err(error) => Err(error),
        },
        Err(Error::NotFound) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Tier 2 execution cannot begin while an active criterion has no Task owner.
pub fn ensure_coverage(db: &Connection, work: &str) -> Result<()> {
    match one(db, sql::UNCOVERED, [work]) {
        Err(Error::NotFound) => Ok(()),
        Ok(_) => Err(Error::Invalid(
            "Every criterion must be covered by some Task's acceptance_refs before execution starts",
        )),
        Err(error) => Err(error),
    }
}

/// The ordinary model round selects a tier through its bootstrap/escalation op.
/// A stored higher tier wins; there is no pre-model signal or classifier call.
pub fn selected_scope(
    db: &Connection,
    scope: &apply::ApplyScope,
    input: &tool_ops::Apply,
) -> Result<apply::ApplyScope> {
    let mut selected = scope.clone();
    if let Some(work) = scope.work_id.as_deref() {
        let work = read_work(db, work)?;
        let current = work["tier"].as_u64().ok_or(Error::Invalid("tier"))?;
        selected.tier = selected
            .tier
            .max(u8::try_from(current).map_err(|_| Error::Invalid("tier"))?);
    }
    for op in &input.operations {
        let proposed = match op {
            tool_ops::Operation::CreateLight { tier, .. } => tier.unwrap_or(1),
            tool_ops::Operation::Escalate { tier, reason } => {
                if *tier != 2 || reason.trim().is_empty() {
                    return Err(Error::Invalid("escalation requires tier 2 and a reason"));
                }
                *tier
            }
            tool_ops::Operation::Propose { .. } if scope.work_id.is_none() => 2,
            _ => continue,
        };
        if !(1..=2).contains(&proposed) {
            return Err(Error::Invalid("managed tier must be 1 or 2"));
        }
        if proposed < selected.tier {
            return Err(Error::Invalid("tier escalation is upward only"));
        }
        selected.tier = proposed;
    }
    Ok(selected)
}

pub fn ensure_detail(db: &Connection, work: &str) -> Result<()> {
    match one(db, sql::DETAIL, [work]) {
        Ok(_) => Ok(()),
        Err(Error::NotFound) => Err(Error::Invalid(
            "Tier 2 requires active Spec detail before execution; publish detail and retry in this round",
        )),
        Err(error) => Err(error),
    }
}

/// Delegation uses the same Tier 2 floor as ordinary execution admission.
pub fn delegation_floor(db: &Connection, work: &str) -> Result<()> {
    let row = read_work(db, work)?;
    let tier = row["tier"].as_u64().ok_or(Error::Invalid("tier"))?;
    check_floor(
        db,
        Some(work),
        tier as u8,
        0,
        Floors {
            delegation_or_child_assignment: true,
            ..Floors::default()
        },
    )?;
    ensure_detail(db, work)?;
    ensure_coverage(db, work)
}
