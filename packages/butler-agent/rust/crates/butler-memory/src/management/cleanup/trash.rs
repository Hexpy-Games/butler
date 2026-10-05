use super::{CleanupResult, receipt, safety, save, validate_id};
use std::{fs, io, path::Path};
use tokio_util::sync::CancellationToken;

pub(super) fn finish_prior(
    memory: &Path,
    current: &mut CleanupResult,
    token: &CancellationToken,
    publish: &dyn Fn(CleanupResult),
) -> io::Result<()> {
    for index in 0..current.items.len() {
        finish_item(memory, current, index, token)?;
    }
    for entry in fs::read_dir(memory.join("management/operations"))? {
        safety::cancelled(token)?;
        let id = entry?.file_name().to_string_lossy().into_owned();
        validate_id(&id)?;
        if id == current.operation_id {
            continue;
        }
        let Some(mut saved) = receipt(memory, &id)? else {
            continue;
        };
        let pending: Vec<usize> = saved
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| (item.outcome == "renamed").then_some(index))
            .collect();
        if pending.is_empty() {
            continue;
        }
        for &index in &pending {
            finish_item(memory, &mut saved, index, token)?;
        }
        for item in pending.into_iter().filter_map(|index| {
            saved
                .items
                .get(index)
                .filter(|item| item.outcome == "removed")
        }) {
            // A crash may leave the old receipt at "renamed" after the new
            // receipt already recorded its removal. Generation UUIDs are unique.
            if !current
                .items
                .iter()
                .any(|prior| prior.name == item.name && prior.outcome == "removed")
            {
                current.bytes_reclaimed = current
                    .bytes_reclaimed
                    .saturating_add(item.allocated_bytes.unwrap_or(0));
                current.items.push(item.clone());
            }
        }
        // Commit recovery attribution before settling the old receipt. Repeated
        // reconciliation deduplicates by generation ID instead of adding twice.
        save(memory, current, publish)?;
        // The interrupted old plan is not resumed implicitly. Its trash is settled
        // by this explicit request, whose new analysis supplies the complete result.
        if matches!(saved.phase.as_str(), "preparing" | "removing") {
            saved.phase = "cancelled".into();
        }
        save(memory, &mut saved, publish)?;
    }
    Ok(())
}

pub(super) fn finish_item(
    memory: &Path,
    result: &mut CleanupResult,
    index: usize,
    token: &CancellationToken,
) -> io::Result<()> {
    safety::cancelled(token)?;
    let Some(item) = result
        .items
        .get_mut(index)
        .filter(|item| item.outcome == "renamed")
    else {
        return Ok(());
    };
    // Only validated unreferenced artefacts recorded by this backend grant deletion authority.
    if !matches!(
        item.reason.as_str(),
        "unpublished_empty_generation" | "unreferenced_generation" | "unreferenced_artifact"
    ) {
        return Err(io::Error::other("Unknown trash provenance"));
    }
    super::nested::validate_name(&item.name)?;
    let trash = memory
        .join("management/operations")
        .join(&result.operation_id)
        .join("trash");
    let path = trash.join(index.to_string());
    crate::cognition::ensure_data_authority(memory, &[&path]).map_err(io::Error::other)?;
    if path.exists() {
        // remove_dir deliberately refuses anything that acquired content after planning.
        if item.reason == "unpublished_empty_generation" {
            fs::remove_dir(&path)?;
        } else {
            super::files(&path, token)?;
            remove_tree(memory, &path, token)?;
        }
        butler_platform::secure_fs::sync_path(&trash)?;
    } else if memory.join(&item.name).exists() {
        item.outcome = "kept".into();
        item.reason = "rename_not_committed".into();
        return Ok(());
    }
    item.outcome = "removed".into();
    result.bytes_reclaimed = result
        .bytes_reclaimed
        .saturating_add(item.allocated_bytes.unwrap_or(0));
    Ok(())
}

fn remove_tree(memory: &Path, root: &Path, token: &CancellationToken) -> io::Result<()> {
    let mut pending = vec![(root.to_owned(), false)];
    while let Some((path, visited)) = pending.pop() {
        safety::cancelled(token)?;
        crate::cognition::ensure_data_authority(memory, &[&path]).map_err(io::Error::other)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_symlink() {
            return Err(io::Error::other("Linked trash artifact"));
        }
        if metadata.is_dir() && !visited {
            pending.push((path.clone(), true));
            for entry in fs::read_dir(path)? {
                pending.push((entry?.path(), false));
            }
        } else if metadata.is_dir() {
            fs::remove_dir(path)?;
        } else {
            butler_platform::secure_fs::remove_tree(&path)?;
        }
    }
    Ok(())
}
