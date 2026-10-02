//! Change-driven background worker; tracked and cancelled with the consumer.
use super::Input;
use crate::cognition::{CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget};

pub(super) async fn kick(input: &Input) -> CognitionResult<bool> {
    if !(input.alias_postings_enabled || input.alias_reclaim_enabled)
        || !input.alias_postings_done.lock().is_empty()
    {
        return Ok(false);
    }
    let owned = input.clone();
    let handle = super::super::blocking::run(move || match &owned.target {
        Some(target) => {
            crate::cognition::resolve_generation(&owned.data_root, &owned.environment, target)
        }
        None => crate::cognition::resolve_active_generation(&owned.data_root, &owned.environment),
    })
    .await?;
    Ok(process(input, Some(&handle)))
}

pub(super) fn process(input: &Input, handle: Option<&MemoryGenerationHandle>) -> bool {
    if !(input.alias_postings_enabled || input.alias_reclaim_enabled)
        || input.shutdown.is_cancelled()
    {
        return false;
    }
    let Some(handle) = handle else {
        return false;
    };
    if !input
        .alias_postings_done
        .lock()
        .insert(handle.graph_path.clone())
    {
        return false;
    }
    let target = input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: handle.generation_id.clone(),
        });
    let owned = input.clone();
    let path = handle.graph_path.clone();
    input.tasks.spawn(async move {
        if let Err(error) = run(&owned, &target).await {
            if !owned.shutdown.is_cancelled() {
                butler_core::diagnostic!("[alias-postings] {}", error.code());
            }
            owned.alias_postings_done.lock().remove(&path);
        }
    });
    true
}

async fn run(input: &Input, target: &MemoryGenerationTarget) -> CognitionResult<()> {
    let session =
        std::sync::Arc::new(crate::cognition::generation::alias_postings::Session::default());
    let result = copy(input, target, session.clone()).await;
    let closed = crate::cognition::generation::alias_postings::close(session).await;
    result.and(closed)
}

async fn copy(
    input: &Input,
    target: &MemoryGenerationTarget,
    session: std::sync::Arc<crate::cognition::generation::alias_postings::Session>,
) -> CognitionResult<()> {
    loop {
        if input.shutdown.is_cancelled() {
            return Ok(());
        }
        let copied = if input.alias_postings_enabled {
            crate::cognition::generation::alias_postings::advance(
                &input.data_root,
                &input.environment,
                input.coordinator.clone(),
                target,
                &input.shutdown,
                session.clone(),
            )
            .await?
        } else {
            false
        };
        let reclaimed = if !copied && input.alias_reclaim_enabled {
            crate::cognition::generation::reclaim_alias_postings(
                &input.data_root,
                &input.environment,
                input.coordinator.clone(),
                target,
                &input.shutdown,
            )
            .await?
        } else {
            false
        };
        if !copied && !reclaimed {
            return Ok(());
        }
        // Outside every lease: give foreground arrivals and pinned readers time.
        tokio::select! {
            ()=input.shutdown.cancelled()=>return Ok(()),
            ()=tokio::time::sleep(std::time::Duration::from_millis(10))=>{},
        }
    }
}
