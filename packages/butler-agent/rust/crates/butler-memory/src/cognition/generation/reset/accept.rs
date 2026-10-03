//! Acceptance records the immutable selection under the shared writer lease.
use super::*;
pub(crate) fn begin(
    root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &CognitionWriteCoordinator,
    id: &str,
    revision: u64,
    project: Option<String>,
    kind: &str,
) -> io::Result<ResetResult> {
    validate(root, paths, id)?;
    if let Some(saved) = receipt(root, paths, id)? {
        if saved.inventory_revision != revision || saved.project_id != project || saved.kind != kind
        {
            return Err(io::Error::other("Operation ID conflicts"));
        }
        return Ok(saved);
    }
    if coordinator.inventory_revision() != revision {
        return Err(io::Error::other("Inventory changed"));
    }
    let old_generation = if kind == "profile" {
        uuid::Uuid::nil().to_string()
    } else {
        let active = resolve_active_generation(root, paths).map_err(io::Error::other)?;
        if active.root
            != paths
                .memory_root(root)
                .join("generations")
                .join(&active.generation_id)
        {
            return Err(io::Error::other("Active v2 generation is required"));
        }
        active.generation_id
    };
    let lease = coordinator
        .try_acquire(&CognitionWriteAcquire::immediate(
            paths.consolidation_lock(root),
            "memory_reset_accept",
        ))
        .map_err(io::Error::other)?
        .ok_or_else(|| io::Error::other("Memory is in use"))?;
    if coordinator.inventory_revision() != revision.saturating_add(1) {
        lease.release(false).map_err(io::Error::other)?;
        return Err(io::Error::other("Inventory changed"));
    }
    let pending = paths
        .memory_root(root)
        .join("management/reset-pending.json");
    crate::coordination::ensure_data_authority(root, &[&pending])?;
    if let Ok(bytes) = fs::read(&pending) {
        let prior: String = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if receipt(root, paths, &prior)?.is_some_and(|receipt| receipt.phase == "preparing") {
            lease.release(false).map_err(io::Error::other)?;
            return Err(io::Error::other("Memory is in use"));
        }
    }
    write_json(&pending, &json!(id))?;
    let instructions = match project.as_deref() {
        Some(project) => {
            crate::cognition::fence_instruction_project(root, paths, coordinator, project)
                .map_err(io::Error::other)?
        }
        None => Vec::new(),
    };
    let result = ResetResult {
        operation_id: id.into(),
        kind: kind.into(),
        project_id: project,
        inventory_revision: revision,
        old_generation,
        phase: "preparing".into(),
        sequence: 1,
        removal_pending: false,
        instructions,
    };
    save(root, paths, &result)?;
    lease.release(false).map_err(io::Error::other)?;
    Ok(result)
}
