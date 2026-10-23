//! Managed Tier 2 controls and worker dispatch follow the live Task lease.
use butler_turn::btcc::{
    BtccError, GuidedCatalogSnapshot, GuidedPhase, GuidedPhaseSelection, PolicyRole,
};

pub(super) async fn configure(
    phase: &mut GuidedPhaseSelection,
    catalog: &GuidedCatalogSnapshot,
    storage: &butler_turn::btcc::BtccStorage,
    session: &str,
) -> Result<(), BtccError> {
    if phase.phase != GuidedPhase::Execution || phase.execution_policy.role == PolicyRole::Worker {
        return Ok(());
    }
    let session = session.to_owned();
    let (tier2, owns_task) = storage
        .work_model_read(move |db| {
            let tier2 = butler_work::store::bound_work(db, &session, None)?
                .is_some_and(|work| work["tier"] == 2);
            let owns_task = tier2 && butler_work::store::tiers::effects_allowed(db, &session)?;
            Ok((tier2, owns_task))
        })
        .await
        .map_err(BtccError::from)?;
    if !tier2 {
        return Ok(());
    }
    let names: &[&str] = if owns_task {
        &["session_control", "delegate_to_worker", "wait_for_worker"]
    } else {
        &["session_control"]
    };
    for name in names {
        if let Some(tool) = catalog.capability_tools().find(|tool| tool.name == *name) {
            if !phase.authorized_names.iter().any(|name| name == &tool.name) {
                phase.authorized_names.push(tool.name.to_owned());
            }
            if !phase
                .provider_tools
                .iter()
                .any(|definition| definition["name"] == tool.name)
            {
                phase.provider_tools.push(tool.definition.clone());
            }
        }
    }
    Ok(())
}
