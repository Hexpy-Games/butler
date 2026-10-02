//! Heavy-pass classification is outside the lease; destinations validate its fence.
use super::{
    FeedbackBufferService, FeedbackEntry, FeedbackPrivacyClass, FeedbackPromotion, FeedbackStatus,
    operator, store,
};
use crate::cognition::{
    CognitionResult, ExplicitMemoryUpdateInput, RememberedRuleOwner, mutable_paths,
};
use crate::profile::ProfileService;
use butler_models::models::{ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    disposition: String,
    #[serde(default)]
    profile_category: String,
}

impl FeedbackBufferService {
    /// Daily/manual routing. No vector work or embedding model is invoked here.
    pub async fn consolidate_feedback(
        &self,
        rules: &RememberedRuleOwner,
        profile: &ProfileService,
        provider: &dyn ProviderPromptPort,
        cancellation: CancellationToken,
    ) -> CognitionResult<Value> {
        self.drain_pending().await?;
        let root = self.paths.cognition_root(&self.data_root).join("feedback");
        let data = self.data_root.clone();
        let (generation, entries) = tokio::task::spawn_blocking(move || {
            mutable_paths::ensure_data_authority(&data, &[&root])?;
            Ok::<_, crate::cognition::CognitionError>((
                store::generation(&root)?,
                store::snapshot(&root)?,
            ))
        })
        .await
        .map_err(store::failure)??;
        let superseded = entries
            .iter()
            .filter(|entry| entry.is_active_at(chrono::Utc::now().timestamp_millis()))
            .flat_map(|entry| entry.conflicts_with.iter().chain(&entry.supersedes))
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let existing = rules.list().await?;
        let mut promoted = 0;
        let mut discarded = 0;
        for entry in entries
            .into_iter()
            .filter(|entry| entry.status == FeedbackStatus::Active)
        {
            if cancellation.is_cancelled() {
                break;
            }
            let fence = FeedbackPromotion::of(&entry, generation.clone());
            if superseded.contains(&entry.feedback_id) {
                discarded += usize::from(self.discard_revision(fence, "superseded").await?);
                continue;
            }
            if let Some(rule) = existing.iter().find(|rule| {
                rule.text.trim() == entry.text.trim()
                    && rule.project_id.as_deref() == entry.scope.strip_prefix("project:")
            }) && (entry.scope == "global" || entry.scope.starts_with("project:"))
            {
                self.link_revision(fence, rule.handle.clone()).await?;
                discarded += 1;
                continue;
            }
            if !entry.is_active_at(chrono::Utc::now().timestamp_millis()) {
                discarded += usize::from(self.discard_revision(fence, "expired").await?);
                continue;
            }
            if entry.category == "quality_signal"
                || !matches!(
                    entry.privacy_class,
                    FeedbackPrivacyClass::Public | FeedbackPrivacyClass::Private
                )
            {
                continue;
            }
            let decision = classify(provider, &entry, cancellation.clone()).await?;
            let (more_promoted, more_discarded) = self
                .route(entry, decision, fence, rules, profile, cancellation.clone())
                .await?;
            promoted += more_promoted;
            discarded += more_discarded;
        }
        Ok(json!({"promoted_count":promoted,"discarded_count":discarded,"raw_text_included":false}))
    }

    async fn route(
        &self,
        entry: FeedbackEntry,
        decision: Decision,
        fence: FeedbackPromotion,
        rules: &RememberedRuleOwner,
        profile: &ProfileService,
        cancellation: CancellationToken,
    ) -> CognitionResult<(usize, usize)> {
        let mut promoted = 0;
        let mut discarded = 0;
        match decision.disposition.as_str() {
            "instructions" if entry.scope == "global" || entry.scope.starts_with("project:") => {
                let receipt = rules
                    .remember_feedback(
                        ExplicitMemoryUpdateInput {
                            text: entry.text.clone(),
                            operation_id: Some(format!(
                                "feedback:{}:{}",
                                entry.feedback_id, fence.generation
                            )),
                            project_id: entry.scope.strip_prefix("project:").map(str::to_owned),
                            conversation_session_id: entry
                                .extra_fields
                                .get("origin_session")
                                .cloned(),
                            conversation_message_id: entry
                                .extra_fields
                                .get("origin_message")
                                .cloned(),
                        },
                        fence,
                        cancellation.clone(),
                    )
                    .await?;
                promoted = usize::from(receipt.state == "active");
            }
            "profile" if entry.scope == "global" => {
                promoted = usize::from(
                    profile
                        .promote_feedback(fence.profile_input(
                            self.paths.cognition_root(&self.data_root).join("feedback"),
                            &entry,
                            decision.profile_category,
                        ))
                        .await
                        .map_err(store::failure)?,
                );
            }
            "discard"
                if entry
                    .extra_fields
                    .get("retention_class")
                    .is_none_or(|r| r != "pinned") =>
            {
                discarded = usize::from(self.discard_revision(fence, "transient").await?);
            }
            _ => {}
        }
        Ok((promoted, discarded))
    }

    async fn link_revision(&self, fence: FeedbackPromotion, link: String) -> CognitionResult<()> {
        self.mutate("feedback_duplicate", move |path| {
            let root = path.parent().unwrap_or(&path);
            if store::generation(root)? != fence.generation {
                return Ok(());
            }
            let mut entries = store::snapshot(root)?;
            if let Some(entry) = entries.iter_mut().find(|entry| {
                entry.feedback_id == fence.feedback_id
                    && entry.updated_at == fence.updated_at
                    && entry.status == FeedbackStatus::Active
            }) {
                entry.status = FeedbackStatus::Discarded;
                entry.expires_at = None;
                entry
                    .extra_fields
                    .insert("resolution_reason".into(), "already_represented".into());
                entry.extra_fields.insert("destination_link".into(), link);
                operator::write_entries(&path, &entries)?;
            }
            Ok(())
        })
        .await
    }

    async fn discard_revision(
        &self,
        fence: FeedbackPromotion,
        reason: &'static str,
    ) -> CognitionResult<bool> {
        self.mutate("feedback_discard", move |path| {
            let root = path.parent().unwrap_or(&path);
            if store::generation(root)? != fence.generation {
                return Ok(false);
            }
            let mut entries = store::snapshot(root)?;
            let Some(entry) = entries.iter_mut().find(|entry| {
                entry.feedback_id == fence.feedback_id
                    && entry.updated_at == fence.updated_at
                    && entry.status == FeedbackStatus::Active
            }) else {
                return Ok(false);
            };
            entry.status = FeedbackStatus::Discarded;
            entry.expires_at = None;
            entry
                .extra_fields
                .insert("resolution_reason".into(), reason.into());
            entry
                .extra_fields
                .insert("retention_class".into(), "audit".into());
            operator::write_entries(&path, &entries)?;
            Ok(true)
        })
        .await
    }
}

async fn classify(
    provider: &dyn ProviderPromptPort,
    entry: &FeedbackEntry,
    cancellation: CancellationToken,
) -> CognitionResult<Decision> {
    let prompt = json!({"feedback_review":{"id":entry.feedback_id,"scope":entry.scope,"category":entry.category,"text":entry.text}}).to_string();
    let instructions = "Classify explicit Recent feedback. Return JSON only: {\"disposition\":\"instructions|profile|discard|defer\",\"profile_category\":\"communication|epistemic_style|boundaries|aesthetics\"}. instructions only for an unambiguous continuing reusable user mandate; profile only for an explicitly stated stable personal preference/fact with consent handled by runtime. Never broaden scope or infer source bans from complaints. Situational/transient feedback: discard. Unresolved or ambiguous corrections: defer. No strategy promotion. Never rewrite the text.";
    let response = provider
        .run_prompt(
            ProviderPromptRequest {
                prompt: &prompt,
                model: None,
                reasoning_effort: None,
                instructions: Some(instructions),
                response_format: None,
                cache_scope: Some("feedback_review"),
                cache_boundary: None,
                cancellation,
                attachments: &[],
                butler_data: None,
                usage_attribution: None,
                stream_observer: None,
                provider_retry_attempts: None,
            },
            ProviderPromptLifecycle::none(),
        )
        .await
        .map_err(store::failure)?;
    serde_json::from_str(&response.text).map_err(store::failure)
}
