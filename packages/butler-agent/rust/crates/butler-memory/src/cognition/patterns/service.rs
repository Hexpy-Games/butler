//! Bounded source pages, model requests and revision-checked publication.
use super::usage::Usage;
use super::{
    PatternError, PatternInput, PatternInputSource, PatternRepository, ensure_active, merge, prompt,
};
use butler_models::models::{ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Consolidation-owned extraction with incremental, revision-checked publication.
pub struct PatternExtractionService {
    root: PathBuf,
    repository: PatternRepository,
    provider: Arc<dyn ProviderPromptPort>,
    source: Arc<dyn PatternInputSource>,
}
#[derive(Default)]
struct Metrics {
    scanned: usize,
    pages: usize,
    created: u64,
    updated: u64,
    dropped: u64,
    bundle: Option<String>,
    candidates: usize,
    usage: Usage,
}
impl Metrics {
    fn view(self, enabled: bool, patterns: usize) -> Map<String, Value> {
        butler_core::json::json_object!({"learning_enabled":enabled,"scanned_event_count":self.scanned,
            "page_count":self.pages,"created_count":self.created,"updated_count":self.updated,
            "dropped_update_count":self.dropped,"pattern_count":patterns,"proposal_bundle_id":self.bundle,
            "proposal_candidate_count":self.candidates,"model_usage":self.usage.summary(),"raw_text_included":false})
    }
}
impl PatternExtractionService {
    /// Compose existing ports; construction performs no work.
    pub fn new(
        root: PathBuf,
        repository: PatternRepository,
        provider: Arc<dyn ProviderPromptPort>,
        source: Arc<dyn PatternInputSource>,
    ) -> Self {
        Self {
            root,
            repository,
            provider,
            source,
        }
    }
    /// The same repository used by explicit user actions.
    pub fn repository(&self) -> &PatternRepository {
        &self.repository
    }
    /// Extract each unread page, then ask once for eligible proposals.
    pub async fn extract(
        &self,
        run_id: &str,
        now: DateTime<Utc>,
        token: &CancellationToken,
    ) -> Result<Map<String, Value>, PatternError> {
        ensure_active(token)?;
        let Some(depth) = self.source.learning_depth().await? else {
            return Ok(Metrics::default().view(false, 0));
        };
        let mut input = self.source.settings().await?;
        input.learning_depth = depth;
        let mut store = self.repository.load().await?;
        let since = store.cursor.unwrap_or(now - Duration::days(28));
        let initial_offset = store.cursor_offset;
        let mut metrics = Metrics::default();
        loop {
            ensure_active(token)?;
            let page = self
                .source
                .page(since, initial_offset + metrics.scanned)
                .await?;
            if page.is_empty() {
                break;
            }
            let reply = self
                .ask(
                    &input,
                    prompt::prompt(&input, &store, Some(&page), now),
                    run_id,
                    token,
                    &mut metrics,
                )
                .await?;
            let updates = merge::reply(&reply, "updates")?;
            let count = merge::merge(&mut store, &page, updates, now);
            metrics.created += count.created;
            metrics.updated += count.updated;
            metrics.dropped += count.dropped;
            metrics.scanned += page.len();
            metrics.pages += 1;
            let cursor = page.last().map(|e| e.created_at);
            let boundary_count = page
                .iter()
                .rev()
                .take_while(|e| Some(e.created_at) == cursor)
                .count();
            store.cursor_offset = if cursor == store.cursor {
                store.cursor_offset + boundary_count
            } else {
                boundary_count
            };
            store.cursor = cursor;
            self.commit(&store, token).await?;
            store.revision += 1;
        }
        if input.level != "off"
            && store.patterns.iter().any(|p| p.proposed_at.is_none())
            && !store.bundles.iter().any(|b| b.run_id == run_id)
        {
            ensure_active(token)?;
            let reply = self
                .ask(
                    &input,
                    prompt::prompt(&input, &store, None, now),
                    run_id,
                    token,
                    &mut metrics,
                )
                .await?;
            let candidates = merge::reply(&reply, "candidates")?;
            metrics.bundle = merge::propose(&mut store, candidates, run_id, &input.level, now);
            if metrics.bundle.is_some() {
                metrics.candidates = store.bundles.last().map_or(0, |b| b.candidates.len());
                self.commit(&store, token).await?;
            }
        }
        Ok(metrics.view(true, store.patterns.len()))
    }
    async fn commit(
        &self,
        store: &super::PatternStore,
        token: &CancellationToken,
    ) -> Result<(), PatternError> {
        ensure_active(token)?;
        if self.source.learning_depth().await?.is_none() {
            return Err(PatternError::Cancelled);
        }
        self.repository
            .commit(store.clone(), store.revision, token)
            .await
    }
    async fn ask(
        &self,
        input: &PatternInput,
        prompt: String,
        run_id: &str,
        token: &CancellationToken,
        metrics: &mut Metrics,
    ) -> Result<String, PatternError> {
        ensure_active(token)?;
        let root = self.root.to_string_lossy();
        let scope = format!("cognition:{run_id}:pattern_extraction:{}", metrics.pages);
        let response = self
            .provider
            .run_prompt(
                ProviderPromptRequest {
                    prompt: &prompt,
                    model: Some(&input.model),
                    reasoning_effort: Some(&input.reasoning),
                    instructions: Some(prompt::PATTERN_INSTRUCTIONS),
                    response_format: None,
                    cache_scope: Some(&scope),
                    cache_boundary: None,
                    cancellation: token.clone(),
                    attachments: &[],
                    butler_data: Some(&root),
                    usage_attribution: Some(
                        &butler_models::models::PromptUsageAttribution::for_phase(
                            "pattern_extraction",
                        ),
                    ),
                    stream_observer: None,
                    provider_retry_attempts: None,
                },
                ProviderPromptLifecycle::none(),
            )
            .await
            .map_err(PatternError::port)?;
        ensure_active(token)?;
        metrics.usage.push(&input.model, response.usage.as_ref());
        Ok(response.text)
    }
}
