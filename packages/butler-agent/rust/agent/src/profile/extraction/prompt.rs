use serde::Serialize;
use serde_json::Value;

use super::super::contracts::ProfilingMode;
use super::types::{CorrectionTargets, MAX_OBSERVATIONS, PROMPT_BYTES, SourceWindow};
use crate::segmentation::split_grapheme_utf8_spans;

pub(super) struct PreparedBatch {
    pub windows: Vec<SourceWindow>,
    pub prompt: String,
    pub consumed: usize,
    pub remainders: Vec<SourceWindow>,
    pub replaced_parent: Option<SourceWindow>,
}

pub(super) fn prepare(
    source: &[SourceWindow],
    mode: ProfilingMode,
    targets: &CorrectionTargets,
) -> PreparedBatch {
    let mut windows = Vec::new();
    let mut consumed = 0;
    let mut remainders = Vec::new();
    while consumed < source.len() && windows.len() < MAX_OBSERVATIONS {
        let mut candidate = source[consumed].clone();
        windows.push(candidate.clone());
        let exceeds_budget = extractor_prompt(&windows, mode, &targets.public).len() > PROMPT_BYTES;
        windows.pop();
        if exceeds_budget {
            if !windows.is_empty() {
                break;
            }
            let Some(split) = split_window(&candidate, mode, &targets.public) else {
                return PreparedBatch {
                    windows: Vec::new(),
                    prompt: String::new(),
                    consumed: 0,
                    remainders: Vec::new(),
                    replaced_parent: None,
                };
            };
            candidate = split[0].clone();
            remainders = split[1..].to_vec();
            windows.push(candidate);
            consumed = 1;
            break;
        }
        windows.push(candidate);
        consumed += 1;
    }
    let replaced_parent = (!remainders.is_empty()).then(|| source[consumed - 1].clone());
    PreparedBatch {
        prompt: extractor_prompt(&windows, mode, &targets.public),
        windows,
        consumed,
        remainders,
        replaced_parent,
    }
}

pub(super) fn extractor_prompt(
    windows: &[SourceWindow],
    mode: ProfilingMode,
    targets: &[Value],
) -> String {
    #[derive(Serialize)]
    struct Observation<'a> {
        #[serde(rename = "ref")]
        reference: &'a str,
        observed_at: &'a str,
        text: &'a str,
    }
    #[derive(Serialize)]
    struct ExtractorPrompt<'a> {
        task: &'static str,
        mode: &'a str,
        rules: [&'static str; 2],
        correction_targets: &'a [Value],
        observations: Vec<Observation<'a>>,
    }
    serde_json::to_string(&ExtractorPrompt {
        task: "extract_profile_candidates",
        mode: mode.as_str(),
        rules: [
            "Evidence refs must be non-empty and come only from delivered observations.",
            "For an explicit correction, contradiction_refs may contain only a delivered correction target_ref and must preserve its category, facet, and applies_when exactly."
        ],
        correction_targets: targets,
        observations: windows
            .iter()
            .take(MAX_OBSERVATIONS)
            .map(|window| Observation {
                reference: &window.evidence_ref,
                observed_at: &window.timestamp,
                text: window.text.as_ref(),
            })
            .collect(),
    })
    .unwrap()
}

pub(super) fn instructions(mode: ProfilingMode) -> String {
    let allowed = if mode == ProfilingMode::Basic {
        "communication, epistemic_style, boundaries"
    } else {
        "identity, cares, values, narrative, agency, epistemic_style, communication, affective_landscape, relationships, aesthetics, boundaries"
    };
    let facets = if mode == ProfilingMode::Basic {
        "tone_preference, explanation_preference, evidence_preference, correction_style, privacy_rules, consent_required"
    } else {
        "identity.self_descriptions, identity.roles, identity.commitments, cares.current_interests, cares.enduring_interests, cares.meaningful_objects, values.explicit_values, values.inferred_values, values.disliked_values, narrative.meaningful_events, narrative.turning_points, narrative.unresolved_threads, agency.goals, agency.active_projects, agency.tensions, agency.avoidance_patterns, epistemic_style.how_the_user_thinks, epistemic_style.evidence_preference, epistemic_style.uncertainty_tolerance, epistemic_style.correction_style, communication.tone_preference, communication.explanation_preference, communication.emotional_mode, affective_landscape.energizers, affective_landscape.frustrations, affective_landscape.comfort_patterns, relationships.important_people_or_groups, relationships.collaboration_preferences, relationships.social_boundaries, aesthetics.taste, aesthetics.anti_taste, aesthetics.quality_sense, boundaries.privacy_rules, boundaries.consent_required, boundaries.sensitive_domains"
    };
    [
        "You are Butler's consent-gated user profile extractor.".into(),
        "Extract durable profile candidates from user-authored canonical conversation observations using a philosophical user-profile template.".into(),
        "Do not summarize the conversation. Do not include raw user text in the output.".into(),
        "Only return candidates that can improve future personalization for the user.".into(),
        format!("Allowed categories: {allowed}."),
        format!("Relevant profile facets to consider: {facets}."),
        "For deep mode, explicitly look for current_interests, meaningful_events, values, narrative threads, active projects, and agency signals before general style signals.".into(),
        "Use facet without the category prefix, for example current_interests, meaningful_events, correction_style, quality_sense, privacy_rules.".into(),
        "Use source_type explicit only when the user directly states a preference, value, boundary, name, goal, or self-description.".into(),
        "Use source_type repeated_observation for repeated behavior across observations.".into(),
        "Use source_type inference only for cautious, low-confidence interpretation.".into(),
        "For basic mode, do not output sensitive personal content; generalize it into non-sensitive communication, epistemic, or boundary preferences when possible.".into(),
        "Mark sensitive_domain true only when the candidate contains personal sensitive material such as health, private family or romantic relationships, personal finance, religion, political belief, legal identity, exact location, credentials, secrets, or similarly sensitive content.".into(),
        "Do not mark ordinary language, public or broad career roles, collaboration preferences, communication style, technical interests, design taste, project context, or safety/privacy rules as sensitive merely because the category is identity, relationships, boundaries, or values.".into(),
        "Also classify each candidate by layer: stable_disposition, contextual_adaptation, current_attention, or narrative_meaning.".into(),
        "stable_disposition is for durable tendencies and values; contextual_adaptation is for situation-specific collaboration rules; current_attention is for active interests/projects; narrative_meaning is for meaningful events, identity stories, and unresolved threads.".into(),
        "Include applies_when, butler_should, and butler_should_not when they help Butler act differently. Keep them short and behavior-level.".into(),
        "Set temporal_scope to transient, active, or durable. Set decay_policy to days_7, days_30, reinforce_or_decay, or never_without_consent.".into(),
        "Set sensitivity to normal, sensitive, or restricted.".into(),
        "Return strict JSON only, with this shape:".into(),
        r#"{"candidates":[{"layer":"current_attention","category":"cares","facet":"current_interests","summary":"short durable candidate, no raw quote","applies_when":["casual_chat"],"butler_should":["adapt examples to this interest when relevant"],"butler_should_not":["overfit unrelated answers to this topic"],"temporal_scope":"active","decay_policy":"days_30","source_type":"explicit","confidence":"medium","evidence_refs":["conversation:cm_..."],"sensitive_domain":false,"sensitivity":"normal","expires_or_decay":"decay"}]}"#.into(),
    ].join("\n")
}

fn split_window(
    window: &SourceWindow,
    mode: ProfilingMode,
    targets: &[Value],
) -> Option<Vec<SourceWindow>> {
    let spans =
        split_grapheme_utf8_spans(window.text.as_ref(), (window.text.len() / 2).max(1) as f64);
    if spans.len() <= 1 {
        return None;
    }
    let mut output = Vec::new();
    for span in spans {
        let child = slice(window, span.start, span.end);
        if extractor_prompt(std::slice::from_ref(&child), mode, targets).len() <= PROMPT_BYTES {
            output.push(child);
        } else {
            output.extend(split_window(&child, mode, targets)?);
        }
    }
    Some(output)
}

fn slice(window: &SourceWindow, start: usize, end: usize) -> SourceWindow {
    super::discovery::make_window(super::discovery::SourceWindowInput {
        message_id: &window.message_id,
        timestamp: &window.timestamp,
        part_id: &window.part_id,
        part_index: window.part_index,
        scalar_pointer: &window.scalar_pointer,
        source_hash: &window.source_hash,
        text: window.text.as_ref(),
        byte_start: start,
        byte_end: end,
    })
    .with_absolute(window.byte_start)
}

trait AbsoluteWindow {
    fn with_absolute(self, base: usize) -> Self;
}
impl AbsoluteWindow for SourceWindow {
    fn with_absolute(mut self, base: usize) -> Self {
        let start = base + self.byte_start;
        let end = base + self.byte_end;
        self.byte_start = start;
        self.byte_end = end;
        let identity = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            self.message_id,
            self.source_hash,
            self.part_id,
            self.scalar_pointer,
            start,
            end,
            super::types::EXTRACTOR_VERSION
        );
        use sha2::{Digest, Sha256};
        self.coverage_key = format!("{:x}", Sha256::digest(identity.as_bytes()));
        self.evidence_ref = format!("profile_window:{}", &self.coverage_key[..24]);
        self
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn bun_window_identity_and_prompt_golden_match() {
        let golden: Value =
            serde_json::from_str(include_str!("../tests/bun-pf1b-golden.json")).unwrap();
        let text = "🙂abcdef";
        let source_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let window =
            super::super::discovery::make_window(super::super::discovery::SourceWindowInput {
                message_id: "message-α",
                timestamp: "2026-09-14T01:02:03.004Z",
                part_id: "part-1",
                part_index: 0.0,
                scalar_pointer: "/content/text",
                source_hash: &source_hash,
                text,
                byte_start: 0,
                byte_end: "🙂abc".len(),
            });
        assert_eq!(source_hash, golden["sourceHash"]);
        assert_eq!(window.coverage_key, golden["coverageKey"]);
        assert_eq!(window.evidence_ref, golden["evidenceRef"]);
        assert_eq!(window.text.as_ref(), golden["windowText"].as_str().unwrap());
        assert_eq!(
            extractor_prompt(&[window], ProfilingMode::Basic, &[]),
            golden["extractorPrompt"]
        );
    }
}
