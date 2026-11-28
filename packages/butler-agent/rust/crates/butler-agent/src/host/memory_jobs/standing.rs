//! Daily folds of conversation statements into user and project pages.
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};

use butler_memory::{
    cognition::{
        self, CognitionPathEnvironment, MemoryGenerationHandle, StandingPage, StandingSheet,
    },
    profile::{ProfileService, ProfilingExtractorModelSnapshot},
};
use butler_models::models::{
    ModelProvider, PromptUsageAttribution, ProviderPromptLifecycle, ProviderPromptPort,
    ProviderPromptRequest,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::host::{DateParser, HostError};

/// Model calls one run may spend on folds. A first build over a long history
/// continues on the following nights (owner decision D3).
const FOLD_CALLS_PER_RUN: u64 = 24;

pub(in crate::host) struct StandingFacts {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    profile: Arc<ProfileService>,
    provider: Arc<ModelProvider>,
    date_parser: Arc<DateParser>,
}

/// What one refresh did, for the cycle log.
#[derive(Default)]
struct FoldEffect {
    calls: u64,
    prompt_tokens: f64,
    output_tokens: f64,
    sources_before: u64,
    sources_after: u64,
    text_before: String,
    text_after: String,
}

impl FoldEffect {
    fn event(&self, page: &StandingPage, error: Option<&HostError>, duration: Duration) -> Value {
        let before: HashSet<_> = self
            .text_before
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let after: HashSet<_> = self
            .text_after
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let mut event = json!({
            "phase": page.phase(),
            "status": if error.is_some() { "error" } else { "ok" },
            "duration_ms": duration.as_millis(),
            "metrics": {
                "calls": self.calls,
                "prompt_tokens": self.prompt_tokens,
                "output_tokens": self.output_tokens,
                "sources_folded": self.sources_after.saturating_sub(self.sources_before),
                "lines_added": after.difference(&before).count(),
                "lines_removed": before.difference(&after).count(),
                "bytes": self.text_after.len(),
            },
        });
        if let Some(project) = page.project() {
            event["project_id"] = json!(project);
        }
        if let Some(error) = error {
            event["error"] = json!({"name": error.message()});
        }
        event
    }
}

impl StandingFacts {
    pub(super) fn new(owners: &super::daily::DailyCognitionOwners) -> Self {
        Self {
            data_root: owners.data_root.clone(),
            paths: owners.paths.clone(),
            profile: owners.profile.clone(),
            provider: owners.provider.clone(),
            date_parser: owners.date_parser.clone(),
        }
    }

    pub(in crate::host) async fn refresh(
        &self,
        started_ms: i64,
        cancellation: &CancellationToken,
    ) -> Result<(), HostError> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let Some((generation, pages)) = tokio::task::spawn_blocking(move || {
            if !cognition::active_memory_descriptor_exists(&data_root, &paths)? {
                return Ok(None);
            }
            let generation = cognition::resolve_active_generation(&data_root, &paths)?;
            let mut pages = vec![StandingPage::User];
            pages.extend(
                cognition::standing_projects(&generation.graph_path)?
                    .into_iter()
                    .map(StandingPage::Project),
            );
            Ok::<_, cognition::CognitionError>(Some((generation, pages)))
        })
        .await
        .map_err(failure)?
        .map_err(failure)?
        else {
            return Ok(());
        };
        let today = self
            .date_parser
            .local_day_and_minute(started_ms)
            .map(|(day, _)| day)
            .unwrap_or_else(|_| {
                let (year, month, day) =
                    butler_core::js_date::civil_from_days(started_ms.div_euclid(86_400_000));
                format!("{year:04}-{month:02}-{day:02}")
            });
        let mut calls_left = FOLD_CALLS_PER_RUN;
        let mut first_error = None;
        for page in pages {
            if cancellation.is_cancelled() {
                break;
            }
            let started = std::time::Instant::now();
            let mut effect = FoldEffect::default();
            let result = self
                .fold(
                    &generation,
                    &page,
                    &mut calls_left,
                    cancellation,
                    &mut effect,
                    &today,
                )
                .await;
            if effect.calls > 0 {
                let event = effect.event(&page, result.as_ref().err(), started.elapsed());
                if let Err(error) =
                    cognition::append_cycle_event(&self.data_root, &self.paths, event).await
                {
                    butler_core::diagnostic!("[standing-facts] event {}", error.code());
                }
            }
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    async fn fold(
        &self,
        generation: &MemoryGenerationHandle,
        page: &StandingPage,
        calls_left: &mut u64,
        cancellation: &CancellationToken,
        effect: &mut FoldEffect,
        today: &str,
    ) -> Result<(), HostError> {
        let graph_path = generation.graph_path.clone();
        let root = generation.root.clone();
        let start_page = page.clone();
        let start = tokio::task::spawn_blocking(move || {
            cognition::standing_start(&graph_path, &root, &start_page)
        })
        .await
        .map_err(failure)?
        .map_err(failure)?;
        let mut building = start.building;
        let mut budget = FoldBudget {
            calls_left,
            capped: !start.lost,
        };
        let mut sheet = start.sheet;
        effect.sources_before = folded_sources(&sheet);
        effect.sources_after = effect.sources_before;
        effect.text_before = sheet.text.clone();
        effect.text_after = sheet.text.clone();
        let model = self.profile.read_extractor_model().await.map_err(failure)?;
        loop {
            if cancellation.is_cancelled() {
                return Ok(());
            }
            let graph_path = generation.graph_path.clone();
            let batch_page = page.clone();
            let (previous, batch) = tokio::task::spawn_blocking(move || {
                cognition::standing_batch(&graph_path, &batch_page, &sheet)
                    .map(|batch| (sheet, batch))
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
            let Some(batch) = batch else {
                return Ok(());
            };
            let text = if batch.lines.is_empty() {
                previous.text
            } else {
                let prompt = cognition::standing_prompt(page, &previous.text, &batch.lines, today);
                let Some(text) = self
                    .fold_text(page, &model, &prompt, cancellation, effect, &mut budget)
                    .await?
                else {
                    return Ok(());
                };
                text
            };
            let next = StandingSheet {
                text,
                through_at: batch.through_at,
                through_id: batch.through_id,
                sources: batch.sources,
                pass: batch.pass,
            };
            let Some(published) = self
                .publish(generation, page, next, &model.effective_model, building)
                .await?
            else {
                return Ok(());
            };
            if published.pass.is_none() {
                building = false;
            }
            effect.sources_after = folded_sources(&published);
            effect.text_after = published.text.clone();
            sheet = published;
        }
    }

    async fn fold_text(
        &self,
        page: &StandingPage,
        model: &ProfilingExtractorModelSnapshot,
        prompt: &str,
        cancellation: &CancellationToken,
        effect: &mut FoldEffect,
        budget: &mut FoldBudget<'_>,
    ) -> Result<Option<String>, HostError> {
        if budget.exhausted() {
            return Ok(None);
        }
        let mut text = self
            .summarize(page, model, prompt, cancellation, effect, budget.calls_left)
            .await?;
        for _ in 0..3 {
            if text.len() <= cognition::STANDING_MAX_BYTES {
                break;
            }
            if budget.exhausted() {
                return Ok(None);
            }
            let prompt = cognition::standing_shorten_prompt(&text);
            text = self
                .summarize(
                    page,
                    model,
                    &prompt,
                    cancellation,
                    effect,
                    budget.calls_left,
                )
                .await?;
        }
        if text.len() > cognition::STANDING_MAX_BYTES {
            return Err(HostError::new("standing_facts_reply_invalid"));
        }
        Ok(Some(text))
    }

    async fn publish(
        &self,
        generation: &MemoryGenerationHandle,
        page: &StandingPage,
        sheet: StandingSheet,
        model: &str,
        building: bool,
    ) -> Result<Option<StandingSheet>, HostError> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let generation_id = generation.generation_id.clone();
        let root = generation.root.clone();
        let model = model.to_owned();
        let page = page.clone();
        tokio::task::spawn_blocking(move || {
            let active =
                cognition::resolve_active_generation(&data_root, &paths).map_err(failure)?;
            if active.generation_id != generation_id {
                return Ok(None);
            }
            cognition::write_standing(&root, &page, &sheet, &model, building).map_err(failure)?;
            Ok(Some(sheet))
        })
        .await
        .map_err(failure)?
    }

    async fn summarize(
        &self,
        page: &StandingPage,
        model: &ProfilingExtractorModelSnapshot,
        prompt: &str,
        cancellation: &CancellationToken,
        effect: &mut FoldEffect,
        calls_left: &mut u64,
    ) -> Result<String, HostError> {
        let effort: butler_models::models::ReasoningEffort =
            serde_json::from_value(serde_json::Value::String(model.reasoning_effort.clone()))
                .map_err(failure)?;
        let root = self.data_root.to_string_lossy();
        let attribution = PromptUsageAttribution::for_phase(page.phase());
        let cache_scope = match page {
            StandingPage::User => "standing-facts",
            StandingPage::Project(_) => "project-page",
        };
        *calls_left = calls_left.saturating_sub(1);
        effect.calls += 1;
        let reply = self
            .provider
            .run_prompt(
                ProviderPromptRequest {
                    prompt,
                    model: Some(&model.effective_model),
                    reasoning_effort: Some(&effort),
                    instructions: Some(page.instructions()),
                    response_format: None,
                    cache_scope: Some(cache_scope),
                    cache_boundary: None,
                    cancellation: cancellation.child_token(),
                    attachments: &[],
                    butler_data: Some(&root),
                    usage_attribution: Some(&attribution),
                    stream_observer: None,
                    provider_retry_attempts: None,
                },
                ProviderPromptLifecycle::none(),
            )
            .await
            .map_err(failure)?;
        if let Some(usage) = reply.usage {
            let prompt_tokens = usage.prompt_tokens.unwrap_or(0.0);
            if prompt_tokens.is_finite() && prompt_tokens >= 0.0 {
                effect.prompt_tokens += prompt_tokens;
            }
            if usage.output_tokens.is_finite() && usage.output_tokens >= 0.0 {
                effect.output_tokens += usage.output_tokens;
            }
        }
        let text = reply.text.trim();
        if text.is_empty() {
            return Err(HostError::new("standing_facts_reply_invalid"));
        }
        Ok(text.to_owned())
    }
}

struct FoldBudget<'a> {
    calls_left: &'a mut u64,
    capped: bool,
}

impl FoldBudget<'_> {
    fn exhausted(&self) -> bool {
        self.capped && *self.calls_left == 0
    }
}

fn folded_sources(sheet: &StandingSheet) -> u64 {
    sheet.sources + sheet.pass.as_ref().map_or(0, |pass| pass.sources)
}

fn failure(error: impl std::error::Error + Send + Sync + 'static) -> HostError {
    HostError::new("standing_facts_failed").with_source(error)
}
