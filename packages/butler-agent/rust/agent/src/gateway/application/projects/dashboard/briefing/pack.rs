//! Source-bounded, model-budgeted facts for project signpost generation.

mod feedback;
mod selection;
mod types;

use feedback::{add_followups, read_followups, read_reports};
pub(super) use selection::resolve_language;
use selection::{document_unit, report_question, sorted_works, work_fact_parts};
use sha2::{Digest, Sha256};
use types::{
    Candidate, Category, Coverage, Fact, HashInput, PromptEnvelope, ReportFact, Source, Unit,
    WorkFact,
};
pub(super) use types::{Pack, PackInput};

use serde::Serialize;
use serde_json::Value;

use super::super::super::app_error;
use super::super::{AppApplication, GatewayApplicationError};
use crate::public_text::sanitize_public_text;

pub(super) const INPUT_TOKENS: u64 = 8_000;
pub(super) const OUTPUT_TOKENS: u64 = 1_200;
pub(super) const GENERATOR_VERSION: &str = "signpost-v4-source-feedback";

pub(super) async fn build(
    application: &AppApplication,
    input: PackInput,
) -> Result<Pack, GatewayApplicationError> {
    let safe = |value: &str| sanitize_public_text(value, "");
    let description = safe(input.description.as_deref().unwrap_or_default());
    let budget = (input.context_tokens / 4).min(INPUT_TOKENS) as f64;
    let mut coverage = Coverage {
        total_works: input
            .snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.works.len()),
        included_works: 0,
        included_documents: 0,
        included_reports: 0,
        excluded_units: 0,
    };
    let mut facts = Vec::new();
    let mut sources = Vec::new();
    let mut candidates = Vec::new();
    let works = input
        .snapshot
        .as_ref()
        .map(|snapshot| sorted_works(&snapshot.works))
        .unwrap_or_default();
    coverage.excluded_units += works.len().saturating_sub(20);
    let ledger_records = input
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.records.as_slice())
        .unwrap_or_default();
    let mut units = Vec::new();
    for work in works.iter().take(20) {
        let Some(revision) = work
            .revision
            .as_ref()
            .filter(|_| work.availability == "ready")
        else {
            coverage.excluded_units += 1;
            continue;
        };
        let source_id = format!("work:{}", work.record.id);
        let view = work.managed.as_ref();
        let source = Source {
            source_id: source_id.clone(),
            kind: "work".into(),
            id: work.record.id.clone(),
            revision: revision.clone(),
            title: safe(view.map_or(&work.record.title, |managed| &managed.objective)),
            session_id: None,
        };
        let (reported_at, summary, proposals) = work_fact_parts(view, work);
        let fact = WorkFact {
            source_id,
            title: source.title.clone(),
            status: view.map_or_else(
                || work.record.status.clone(),
                |managed| managed.status.clone(),
            ),
            reported_at,
            objective: safe(view.map_or(&work.record.title, |managed| &managed.objective)),
            summary: safe(&summary),
            linked_user_followups: None,
        };
        units.push(Unit {
            source,
            fact: Fact::Work(fact),
            proposals: proposals.into_iter().map(|text| safe(&text)).collect(),
            ceiling: 1_000.0 + (budget - 1_000.0) * 0.55,
            category: Category::Work,
        });
    }

    let current_plans = works
        .iter()
        .filter_map(|work| {
            work.managed
                .as_ref()?
                .current_plan
                .as_ref()
                .map(|plan| plan.id.clone())
        })
        .collect::<std::collections::HashSet<_>>();
    let managed_work_ids = works
        .iter()
        .filter(|work| work.managed.is_some())
        .map(|work| work.record.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut documents = ledger_records
        .iter()
        .filter(|record| {
            !record.unavailable
                && matches!(record.kind.as_str(), "spec" | "plan" | "report")
                && !(record.kind == "plan"
                    && record
                        .parent_id
                        .as_deref()
                        .is_some_and(|parent| managed_work_ids.contains(parent))
                    && !current_plans.contains(&record.id))
        })
        .collect::<Vec<_>>();
    documents.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    coverage.excluded_units += documents.len().saturating_sub(12);
    for record in documents.into_iter().take(12) {
        units.push(document_unit(
            record,
            input
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.revision.as_str())
                .unwrap_or_default(),
            budget,
            &safe,
        ));
    }

    let reports = application
        .storage
        .execute({
            let project_id = input.project_id.clone();
            move |db| read_reports(db, &project_id)
        })
        .await
        .map_err(app_error)?;
    coverage.excluded_units += reports.len().saturating_sub(6);
    for report in reports.into_iter().take(6) {
        let source_id = format!("message:{}", report.id);
        let source = Source {
            source_id: source_id.clone(),
            kind: "message".into(),
            id: report.id.clone(),
            revision: report.locator_revision,
            title: safe(&report.title),
            session_id: Some(report.chat_id),
        };
        units.push(Unit {
            source,
            fact: Fact::Report(ReportFact {
                source_id,
                relation: "project_conversation_report_only",
                reported_at: report.updated_at,
                excerpt: safe(&report.excerpt),
                excerpt_truncated: report.chars > 1_200,
                linked_user_followups: None,
            }),
            proposals: vec![report_question(&input.language).into()],
            ceiling: budget,
            category: Category::Report,
        });
    }

    for mut unit in units {
        let followups = application
            .storage
            .execute({
                let project_id = input.project_id.clone();
                let source_id = unit.source.source_id.clone();
                move |db| read_followups(db, &project_id, &source_id)
            })
            .await
            .map_err(app_error)?;
        add_followups(&mut unit.fact, followups);
        let mut additions = unit
            .proposals
            .iter()
            .filter(|text| !text.is_empty())
            .enumerate()
            .map(|(index, text)| Candidate {
                id: format!("{}:{index}", unit.source.source_id),
                source_id: unit.source.source_id.clone(),
                text: text.clone(),
            })
            .collect::<Vec<_>>();
        let mut proposed_sources = sources.clone();
        proposed_sources.push(unit.source.clone());
        let mut proposed_facts = facts.clone();
        proposed_facts.push(unit.fact.clone());
        let mut proposed_candidates = candidates.clone();
        proposed_candidates.append(&mut additions);
        let encoded = serde_json::to_string(&PromptEnvelope {
            description: &description,
            facts: &proposed_facts,
            sources: &proposed_sources,
            candidates: &proposed_candidates,
            coverage: &coverage,
        })
        .map_err(|_| GatewayApplicationError::Internal)?;
        let estimated = application
            .dependencies
            .project_dashboard_briefing
            .estimate_tokens(input.model.clone(), encoded)
            .await?;
        if estimated + 1_000.0 > unit.ceiling {
            coverage.excluded_units += 1;
            continue;
        }
        match unit.category {
            Category::Work => coverage.included_works += 1,
            Category::Document => coverage.included_documents += 1,
            Category::Report => coverage.included_reports += 1,
        }
        sources.push(unit.source);
        facts.push(unit.fact);
        candidates.extend(additions);
    }

    let binding = input.binding;
    let snapshot_revision = input
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.revision.as_str());
    let mut pack = Pack {
        project_id: input.project_id,
        binding,
        language: input.language,
        model: input.model,
        description,
        facts,
        sources,
        candidates,
        coverage,
        revision: String::new(),
        reasoning_effort: input.reasoning_effort,
    };
    let hash_input = HashInput {
        project_id: &pack.project_id,
        binding: &pack.binding,
        language: &pack.language,
        model: &pack.model,
        description: &pack.description,
        facts: &pack.facts,
        sources: &pack.sources,
        candidates: &pack.candidates,
        coverage: &pack.coverage,
        ledger_revision: snapshot_revision,
        reasoning_effort: &pack.reasoning_effort,
        generator: GENERATOR_VERSION,
    };
    let encoded = serde_json::to_vec(&hash_input).map_err(|_| GatewayApplicationError::Internal)?;
    pack.revision = format!("{:x}", Sha256::digest(encoded));
    Ok(pack)
}

pub(super) fn prompt_json(pack: &Pack) -> Result<String, GatewayApplicationError> {
    serde_json::to_string(&PromptEnvelope {
        description: &pack.description,
        facts: &pack.facts,
        sources: &pack.sources,
        candidates: &pack.candidates,
        coverage: &pack.coverage,
    })
    .map_err(|_| GatewayApplicationError::Internal)
}

pub(super) fn public_sources(pack: &Pack) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(&pack.sources).map_err(|_| GatewayApplicationError::Internal)
}

pub(super) fn public_candidates(pack: &Pack) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(&pack.candidates).map_err(|_| GatewayApplicationError::Internal)
}

pub(super) fn public_coverage(pack: &Pack) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(&pack.coverage).map_err(|_| GatewayApplicationError::Internal)
}

pub(super) fn same_source_inputs(left: &Pack, right: &Pack) -> bool {
    #[derive(Serialize)]
    struct Compared<'a> {
        binding: &'a Option<String>,
        language: &'a str,
        model: &'a str,
        facts: &'a [Fact],
        sources: &'a [Source],
        candidates: &'a [Candidate],
        coverage: &'a Coverage,
    }
    let compared_left = Compared {
        binding: &left.binding,
        language: &left.language,
        model: &left.model,
        facts: &left.facts,
        sources: &left.sources,
        candidates: &left.candidates,
        coverage: &left.coverage,
    };
    let compared_right = Compared {
        binding: &right.binding,
        language: &right.language,
        model: &right.model,
        facts: &right.facts,
        sources: &right.sources,
        candidates: &right.candidates,
        coverage: &right.coverage,
    };
    serde_json::to_vec(&compared_left).ok() == serde_json::to_vec(&compared_right).ok()
}

#[cfg(test)]
pub(super) fn validation_fixture() -> Pack {
    Pack {
        project_id: "project-1".into(),
        binding: Some("ledger-1".into()),
        language: "en".into(),
        model: "provider/model".into(),
        description: "Project purpose".into(),
        facts: Vec::new(),
        sources: vec![Source {
            source_id: "work:work-1".into(),
            kind: "work".into(),
            id: "work-1".into(),
            revision: "revision-1".into(),
            title: "Work".into(),
            session_id: None,
        }],
        candidates: vec![Candidate {
            id: "work:work-1:0".into(),
            source_id: "work:work-1".into(),
            text: "Review the remaining question".into(),
        }],
        coverage: Coverage {
            total_works: 1,
            included_works: 1,
            included_documents: 0,
            included_reports: 0,
            excluded_units: 0,
        },
        revision: "source-revision".into(),
        reasoning_effort: "high".into(),
    }
}
