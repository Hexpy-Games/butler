mod commit;
mod coverage;
mod discovery;
mod import;
mod parser;
mod prompt;
mod result;
mod runtime;
mod targets;
mod types;

use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::contracts::*;
use super::{extractor_config, storage};
use crate::coordination::CognitionWriteCoordinator;
use crate::models::ProviderPromptPort;
use result::{CaptureResultInput, empty_result, interruption, result, safe_error};

pub(super) struct Dependencies {
    pub root: PathBuf,
    pub lock: PathBuf,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub host: Arc<dyn ProfileHostFacts>,
    pub sources: Arc<dyn CanonicalProfileSourceFactory>,
    pub provider: Arc<dyn ProviderPromptPort>,
    pub active_claims: Arc<Mutex<HashSet<String>>>,
}

pub(super) async fn import(
    dependencies: Dependencies,
    options: ProfileThirdPartyImportOptions,
    cancellation: CancellationToken,
) -> ProfileResult<ProfileThirdPartyImportResult> {
    import::run(dependencies, options, cancellation).await
}

pub(super) async fn capture(
    dependencies: Dependencies,
    options: ProfileModelTranscriptCaptureOptions,
    provider_cancellation: CancellationToken,
) -> ProfileResult<ProfileModelTranscriptCaptureResult> {
    let root = dependencies.root.clone();
    let initial = runtime::blocking({
        let sources = dependencies.sources.clone();
        let scan = options.scan.clone();
        move || {
            let model = extractor_config::read(&root);
            let consent = storage::read_consent(&root);
            let read = if consent.mode == ProfilingMode::Off {
                None
            } else {
                Some(discovery::read(&root, sources.as_ref(), &scan)?)
            };
            Ok((model, consent, read))
        }
    })
    .await?;
    let (mut extractor_model, consent, read) = initial;
    let Some(read) = read else {
        return Ok(empty_result(extractor_model, &consent));
    };
    runtime::with_gate(&dependencies, Some(provider_cancellation.clone()), {
        let root = dependencies.root.clone();
        let host = dependencies.host.clone();
        let read = read.clone();
        move || coverage::persist_discovery(&root, &read, &host.now_iso())
    })
    .await?;
    if read.windows.is_empty() {
        let tracked = HashSet::new();
        let counts = runtime::blocking({
            let root = dependencies.root.clone();
            move || coverage::counts(&root, &tracked)
        })
        .await?;
        let unfinished = read.discovery_incomplete || read.current_obligation_count > 0;
        return Ok(result(CaptureResultInput {
            read: &read,
            mode: consent.mode,
            model: extractor_model,
            called: false,
            usage: ProfileModelUsageSummary::default(),
            error: unfinished.then(|| "profile source discovery remains unfinished".into()),
            counts,
            incomplete: unfinished,
            captured: 0,
        }));
    }
    let model = options
        .model
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(|value| crate::models::parse_model_ref(value).canonical_ref)
        .unwrap_or_else(|| extractor_model.effective_model.clone());
    extractor_model.effective_model = model.clone();
    let raw_max_batches = options.max_model_batches.unwrap_or(8.0);
    let max_batches = if raw_max_batches.is_nan() {
        f64::NAN
    } else {
        raw_max_batches.clamp(1.0, 120.0)
    };
    let cache_scope = options
        .cache_scope
        .as_deref()
        .unwrap_or("profile-extractor")
        .to_owned();
    let mut ids = HashSet::new();
    let mut tracked = read
        .windows
        .iter()
        .map(|value| value.coverage_key.clone())
        .collect::<HashSet<_>>();
    let mut usage = ProfileModelUsageSummary::default();
    let mut called = false;
    let mut model_error = None;
    let mut pending = read.windows.clone();
    let mut batches = 0;
    while !pending.is_empty() && f64::from(batches) < max_batches {
        let target_root = dependencies.root.clone();
        let target_sources = dependencies.sources.clone();
        let target_salt = pending[0].evidence_ref.clone();
        let now_ms = dependencies.host.now_epoch_millis();
        let correction = runtime::blocking(move || {
            targets::read(
                &target_root,
                target_sources.as_ref(),
                consent.mode,
                &target_salt,
                now_ms,
            )
        })
        .await?;
        let prepared = prompt::prepare(&pending, consent.mode, &correction);
        if prepared.windows.is_empty() {
            let failure = "profile source grapheme exceeds prompt budget";
            runtime::with_gate(&dependencies, Some(provider_cancellation.clone()), {
                let root = dependencies.root.clone();
                let host = dependencies.host.clone();
                let window = pending[0].clone();
                move || coverage::mark_failed_unclaimed(&root, &window, failure, host.as_ref())
            })
            .await
            .ok();
            model_error = Some(failure.into());
            break;
        }
        if let Some(parent) = &prepared.replaced_parent {
            let children = [prepared.windows.clone(), prepared.remainders.clone()].concat();
            let replaced =
                runtime::with_gate(&dependencies, Some(provider_cancellation.clone()), {
                    let root = dependencies.root.clone();
                    let host = dependencies.host.clone();
                    let active = dependencies.active_claims.clone();
                    let parent = parent.clone();
                    move || {
                        coverage::replace_parent(&root, &parent, &children, host.as_ref(), &active)
                    }
                })
                .await?;
            if !replaced {
                model_error = Some("profile source coverage changed".into());
                break;
            }
        }
        if prepared.remainders.is_empty() {
            pending.drain(0..prepared.consumed);
        } else {
            tracked.remove(&pending[0].coverage_key);
            for window in prepared.windows.iter().chain(&prepared.remainders) {
                tracked.insert(window.coverage_key.clone());
            }
            pending.splice(0..1, prepared.remainders.clone());
        }
        batches += 1;
        let windows = prepared.windows;
        let nonce = runtime::with_gate(&dependencies, Some(provider_cancellation.clone()), {
            let root = dependencies.root.clone();
            let host = dependencies.host.clone();
            let active = dependencies.active_claims.clone();
            let windows = windows.clone();
            move || coverage::claim(&root, &windows, host.as_ref(), &active)
        })
        .await?;
        let Some(nonce) = nonce else {
            model_error = Some("profile source is already being processed".into());
            break;
        };
        let batch_result = runtime::run_batch(
            &dependencies,
            runtime::BatchInput {
                windows: &windows,
                targets: &correction,
                prompt: &prepared.prompt,
                model: &model,
                reasoning_effort: &extractor_model.reasoning_effort,
                cache_scope: &cache_scope,
                mode: consent.mode,
                cancellation: &provider_cancellation,
            },
            &mut usage,
            &mut called,
        )
        .await;
        match batch_result {
            Ok((extracted, provider_usage)) => {
                let committed =
                    runtime::with_gate(&dependencies, Some(provider_cancellation.clone()), {
                        let root = dependencies.root.clone();
                        let sources = dependencies.sources.clone();
                        let host = dependencies.host.clone();
                        let expected = consent.clone();
                        let windows = windows.clone();
                        let correction = correction.private.clone();
                        let nonce = nonce.clone();
                        move || {
                            commit::commit(commit::CommitInput {
                                root: &root,
                                sources: sources.as_ref(),
                                host: host.as_ref(),
                                expected_consent: &expected,
                                windows: &windows,
                                extracted,
                                usage: provider_usage.as_ref(),
                                offered_corrections: &correction,
                                nonce: &nonce,
                            })
                        }
                    })
                    .await;
                match committed {
                    Ok(next) => ids.extend(next),
                    Err(error) => {
                        let failure = safe_error(&error);
                        if !interruption(&error) {
                            runtime::mark_batch_failed(
                                &dependencies,
                                &windows,
                                &nonce,
                                &failure,
                                &usage,
                                &provider_cancellation,
                            )
                            .await
                            .ok();
                        }
                        model_error = Some(failure);
                    }
                }
            }
            Err(error) => {
                let failure = safe_error(&error);
                runtime::mark_batch_failed(
                    &dependencies,
                    &windows,
                    &nonce,
                    &failure,
                    &usage,
                    &provider_cancellation,
                )
                .await
                .ok();
                model_error = Some(failure);
            }
        }
        let release = runtime::with_gate(&dependencies, None, {
            let root = dependencies.root.clone();
            let host = dependencies.host.clone();
            let active = dependencies.active_claims.clone();
            let windows = windows.clone();
            let nonce = nonce.clone();
            move || coverage::release(&root, &windows, &nonce, host.as_ref(), &active)
        })
        .await;
        if let Err(error) = release {
            coverage::forget(
                &dependencies.root,
                &windows,
                &nonce,
                &dependencies.active_claims,
            );
            return Err(error);
        }
        if model_error.is_some() {
            break;
        }
    }
    let counts = runtime::blocking({
        let root = dependencies.root.clone();
        let tracked = tracked.clone();
        move || coverage::counts(&root, &tracked)
    })
    .await?;
    if model_error.is_none() && (counts.pending > 0 || counts.failed > 0) {
        model_error = Some("profile source coverage remains unfinished".into());
    }
    if model_error.is_none() && (read.discovery_incomplete || !pending.is_empty()) {
        model_error = Some("profile source discovery remains unfinished".into());
    }
    Ok(result(CaptureResultInput {
        read: &read,
        mode: consent.mode,
        model: extractor_model,
        called,
        usage,
        error: model_error,
        counts,
        incomplete: read.discovery_incomplete || !pending.is_empty(),
        captured: ids.len(),
    }))
}
