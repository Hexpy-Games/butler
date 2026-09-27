//! Transcript capture: discovers user text the extractor has not read yet,
//! sends it in prompt-budgeted batches, and commits the candidates each
//! batch returns while holding the batch's coverage claim.

use std::collections::HashSet;

use tokio_util::sync::CancellationToken;

use super::super::contracts::*;
use super::super::{extractor_config, storage};
use super::result::{CaptureResultInput, empty_result, interruption, result, safe_error};
use super::types::{CorrectionTargets, SourceRead, SourceWindow};
use super::{Dependencies, commit, coverage, discovery, prompt, runtime, targets};

/// Captures profile candidates from transcript text the extractor has not
/// read yet.
pub(in super::super) async fn capture(
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
        return nothing_to_read(&dependencies, &read, consent.mode, extractor_model).await;
    }
    let model = runtime::chosen_model(options.model.as_deref(), &extractor_model.effective_model);
    extractor_model.effective_model = model.clone();
    let max_batches = batch_limit(options.max_model_batches);
    let mut session = Capture {
        dependencies: &dependencies,
        consent: &consent,
        cancellation: &provider_cancellation,
        model,
        reasoning_effort: extractor_model.reasoning_effort.clone(),
        cache_scope: options
            .cache_scope
            .as_deref()
            .unwrap_or("profile-extractor")
            .to_owned(),
        ids: HashSet::new(),
        tracked: read
            .windows
            .iter()
            .map(|value| value.coverage_key.clone())
            .collect(),
        usage: ProfileModelUsageSummary::default(),
        called: false,
        model_error: None,
        pending: read.windows.clone(),
    };
    let mut batches = 0_u32;
    while !session.pending.is_empty() && f64::from(batches) < max_batches {
        let Some(batch) = session.next_batch().await? else {
            break;
        };
        batches += 1;
        session.process(batch).await?;
        if session.model_error.is_some() {
            break;
        }
    }
    session.finish(&read, extractor_model).await
}

/// How many extractor batches one capture may send: 8 by default, clamped
/// to 1..=120 (NaN sends none).
fn batch_limit(requested: Option<f64>) -> f64 {
    let requested = requested.unwrap_or(8.0);
    if requested.is_nan() {
        f64::NAN
    } else {
        requested.clamp(1.0, 120.0)
    }
}

/// The result when discovery found no window to send.
async fn nothing_to_read(
    dependencies: &Dependencies,
    read: &SourceRead,
    mode: ProfilingMode,
    model: ProfilingExtractorModelSnapshot,
) -> ProfileResult<ProfileModelTranscriptCaptureResult> {
    let tracked = HashSet::new();
    let counts = runtime::blocking({
        let root = dependencies.root.clone();
        move || coverage::counts(&root, &tracked)
    })
    .await?;
    let unfinished = read.discovery_incomplete || read.current_obligation_count > 0;
    Ok(result(CaptureResultInput {
        read,
        mode,
        model,
        called: false,
        usage: ProfileModelUsageSummary::default(),
        error: unfinished.then(|| "profile source discovery remains unfinished".into()),
        counts,
        incomplete: unfinished,
        captured: 0,
    }))
}

/// One capture run: the batches still pending and what the sent ones
/// produced.
struct Capture<'a> {
    dependencies: &'a Dependencies,
    consent: &'a ProfilingConsentSnapshot,
    cancellation: &'a CancellationToken,
    model: String,
    reasoning_effort: String,
    cache_scope: String,
    /// Candidates committed so far.
    ids: HashSet<String>,
    /// Coverage keys this run is responsible for.
    tracked: HashSet<String>,
    usage: ProfileModelUsageSummary,
    called: bool,
    /// Why the run stopped early.
    model_error: Option<String>,
    pending: Vec<SourceWindow>,
}

/// The windows sent in one extractor request.
struct Batch {
    windows: Vec<SourceWindow>,
    prompt: String,
    correction: CorrectionTargets,
}

impl Capture<'_> {
    /// Takes the next batch off the pending windows, splitting a window that
    /// alone exceeds the prompt budget; `None` (with `model_error` set) when
    /// no batch can be formed.
    async fn next_batch(&mut self) -> ProfileResult<Option<Batch>> {
        let dependencies = self.dependencies;
        let Some(first) = self.pending.first().cloned() else {
            return Ok(None);
        };
        let correction = runtime::blocking({
            let root = dependencies.root.clone();
            let sources = dependencies.sources.clone();
            let mode = self.consent.mode;
            let salt = first.evidence_ref.clone();
            let now_ms = dependencies.host.now_epoch_millis();
            move || targets::read(&root, sources.as_ref(), mode, &salt, now_ms)
        })
        .await?;
        let prepared = prompt::prepare(&self.pending, self.consent.mode, &correction);
        if prepared.windows.is_empty() {
            let failure = "profile source grapheme exceeds prompt budget";
            runtime::with_gate(dependencies, Some(self.cancellation.clone()), {
                let root = dependencies.root.clone();
                let host = dependencies.host.clone();
                move || coverage::mark_failed_unclaimed(&root, &first, failure, host.as_ref())
            })
            .await
            .ok();
            self.model_error = Some(failure.into());
            return Ok(None);
        }
        if let Some(parent) = &prepared.replaced_parent {
            let children = [prepared.windows.clone(), prepared.remainders.clone()].concat();
            let replaced = runtime::with_gate(dependencies, Some(self.cancellation.clone()), {
                let root = dependencies.root.clone();
                let host = dependencies.host.clone();
                let active = dependencies.active_claims.clone();
                let parent = parent.clone();
                move || coverage::replace_parent(&root, &parent, &children, host.as_ref(), &active)
            })
            .await?;
            if !replaced {
                self.model_error = Some("profile source coverage changed".into());
                return Ok(None);
            }
        }
        if prepared.remainders.is_empty() {
            self.pending.drain(0..prepared.consumed);
        } else {
            self.tracked.remove(&first.coverage_key);
            for window in prepared.windows.iter().chain(&prepared.remainders) {
                self.tracked.insert(window.coverage_key.clone());
            }
            self.pending.splice(0..1, prepared.remainders);
        }
        Ok(Some(Batch {
            windows: prepared.windows,
            prompt: prepared.prompt,
            correction,
        }))
    }

    /// Claims the batch's coverage, extracts and commits it, and releases
    /// the claim; a failed release is returned after the claim is forgotten.
    async fn process(&mut self, batch: Batch) -> ProfileResult<()> {
        let dependencies = self.dependencies;
        let nonce = runtime::with_gate(dependencies, Some(self.cancellation.clone()), {
            let root = dependencies.root.clone();
            let host = dependencies.host.clone();
            let active = dependencies.active_claims.clone();
            let windows = batch.windows.clone();
            move || coverage::claim(&root, &windows, host.as_ref(), &active)
        })
        .await?;
        let Some(nonce) = nonce else {
            self.model_error = Some("profile source is already being processed".into());
            return Ok(());
        };
        self.extract_and_commit(&batch, &nonce).await;
        let release = runtime::with_gate(dependencies, None, {
            let root = dependencies.root.clone();
            let host = dependencies.host.clone();
            let active = dependencies.active_claims.clone();
            let windows = batch.windows.clone();
            let nonce = nonce.clone();
            move || coverage::release(&root, &windows, &nonce, host.as_ref(), &active)
        })
        .await;
        if let Err(error) = release {
            coverage::forget(
                &dependencies.root,
                &batch.windows,
                &nonce,
                &dependencies.active_claims,
            );
            return Err(error);
        }
        Ok(())
    }

    /// Sends the batch and commits what came back; a failure is recorded in
    /// `model_error`, and (unless the commit was interrupted) on the claimed
    /// coverage rows.
    async fn extract_and_commit(&mut self, batch: &Batch, nonce: &str) {
        let dependencies = self.dependencies;
        let extracted = runtime::run_batch(
            dependencies,
            runtime::BatchInput {
                windows: &batch.windows,
                targets: &batch.correction,
                prompt: &batch.prompt,
                model: &self.model,
                reasoning_effort: &self.reasoning_effort,
                cache_scope: &self.cache_scope,
                mode: self.consent.mode,
                cancellation: self.cancellation,
            },
            &mut self.usage,
            &mut self.called,
        )
        .await;
        let (error, mark_failed) = match extracted {
            Err(error) => (error, true),
            Ok((extracted, provider_usage)) => {
                let committed =
                    runtime::with_gate(dependencies, Some(self.cancellation.clone()), {
                        let root = dependencies.root.clone();
                        let sources = dependencies.sources.clone();
                        let host = dependencies.host.clone();
                        let expected = self.consent.clone();
                        let windows = batch.windows.clone();
                        let correction = batch.correction.private.clone();
                        let nonce = nonce.to_owned();
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
                    Ok(next) => {
                        self.ids.extend(next);
                        return;
                    }
                    Err(error) => {
                        let interrupted = interruption(&error);
                        (error, !interrupted)
                    }
                }
            }
        };
        let failure = safe_error(&error);
        if mark_failed {
            runtime::mark_batch_failed(
                dependencies,
                &batch.windows,
                nonce,
                &failure,
                &self.usage,
                self.cancellation,
            )
            .await
            .ok();
        }
        self.model_error = Some(failure);
    }

    /// The capture result once the loop stops.
    async fn finish(
        self,
        read: &SourceRead,
        model: ProfilingExtractorModelSnapshot,
    ) -> ProfileResult<ProfileModelTranscriptCaptureResult> {
        let counts = runtime::blocking({
            let root = self.dependencies.root.clone();
            let tracked = self.tracked.clone();
            move || coverage::counts(&root, &tracked)
        })
        .await?;
        let mut model_error = self.model_error;
        if model_error.is_none() && (counts.pending > 0 || counts.failed > 0) {
            model_error = Some("profile source coverage remains unfinished".into());
        }
        let incomplete = read.discovery_incomplete || !self.pending.is_empty();
        if model_error.is_none() && incomplete {
            model_error = Some("profile source discovery remains unfinished".into());
        }
        Ok(result(CaptureResultInput {
            read,
            mode: self.consent.mode,
            model,
            called: self.called,
            usage: self.usage,
            error: model_error,
            counts,
            incomplete,
            captured: self.ids.len(),
        }))
    }
}
