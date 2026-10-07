use super::AgentLoop;
/// Drop also releases request snapshots when execution errors or is aborted.
pub(super) struct CacheWaitGuard<'a> {
    pub(super) agent: &'a dyn AgentLoop,
    pub(super) turn: &'a str,
    pub(super) waiting: bool,
}
impl Drop for CacheWaitGuard<'_> {
    fn drop(&mut self) {
        if !self.waiting {
            self.agent.stop_cache_wait(self.turn);
        }
    }
}

pub(super) fn validate_suspension(
    transition: &super::TurnTransition,
    committed: &super::TurnRecord,
) -> Result<(), super::BtccError> {
    if let super::TurnTransition::Suspend { reason, .. } = transition
        && committed.suspension != Some(*reason)
    {
        return Err(super::BtccError::detected(
            super::BtccCode::SuspensionNotPersisted,
            "BTCC suspension commit did not persist its reason",
        ));
    }
    Ok(())
}
