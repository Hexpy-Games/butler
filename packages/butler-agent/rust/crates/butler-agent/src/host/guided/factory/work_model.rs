//! Only managed Tier 2 parents receive the session control schema.
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
    let tier2 = storage
        .work_model_read(move |db| {
            Ok(butler_work::store::bound_work(db, &session, None)?
                .is_some_and(|work| work["tier"] == 2))
        })
        .await
        .map_err(BtccError::from)?;
    if tier2
        && let Some(tool) = catalog
            .capability_tools()
            .find(|tool| tool.name == "session_control")
    {
        phase.authorized_names.push(tool.name.to_owned());
        phase.provider_tools.push(tool.definition.clone());
    }
    Ok(())
}
