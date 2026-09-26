use super::{
    ExtractAlias, ExtractClaim, ExtractInput, ExtractNode, ExtractOutput, ExtractRelation,
    NodeResolution, QuoteRef,
};
use crate::cognition::{CognitionError, CognitionResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
mod validation;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct Meaning {
    pub status: String,
    pub entities: Vec<MeaningEntity>,
    pub items: Vec<Value>,
    pub attributes: Vec<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct MeaningEntity {
    pub name: String,
    pub evidence: Vec<f64>,
}
#[derive(Clone, Debug, Serialize)]
pub(in crate::cognition) struct Passage {
    pub id: usize,
    pub text: String,
    pub quote: QuoteRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

pub(in crate::cognition) fn source_passages(input: &ExtractInput) -> CognitionResult<Vec<Passage>> {
    let mut passages = Vec::new();
    for unit in &input.source_units {
        let mut covered = 0usize;
        for sentence in crate::segmentation::sentence_segments(&unit.text) {
            let clusters =
                crate::segmentation::grapheme_segments(sentence.text).collect::<Vec<_>>();
            for group in clusters.chunks(256) {
                let start = sentence.start + group.first().map_or(0, |x| x.start);
                let end = sentence.start + group.last().map_or(0, |x| x.end);
                let text = unit.text[start..end].to_owned();
                let occurrence = unit.text[..start].match_indices(&text).count();
                let context = input.context_units.iter().find(|entry| {
                    entry.source_span.as_ref().is_some_and(|span| {
                        span.source_ref == unit.ref_id
                            && span.focus_start == start as f64
                            && span.focus_end == end as f64
                    })
                });
                let (quote, before, after) = if let Some(context) = context {
                    let span = context.source_span.as_ref().unwrap();
                    let prefix = span.prefix_bytes as usize;
                    let focus_end = prefix + text.len();
                    (
                        QuoteRef {
                            unit_ref: context.ref_id.clone(),
                            quote: context.text.clone(),
                            occurrence: 0,
                        },
                        Some(context.text[..prefix].to_owned()),
                        Some(context.text[focus_end..].to_owned()),
                    )
                } else {
                    (
                        QuoteRef {
                            unit_ref: unit.ref_id.clone(),
                            quote: text.clone(),
                            occurrence,
                        },
                        None,
                        None,
                    )
                };
                passages.push(Passage {
                    id: passages.len(),
                    text,
                    quote,
                    before,
                    after,
                });
                covered = end;
            }
        }
        if covered != unit.text.len() {
            return Err(error("memory_extract_source_coverage"));
        }
    }
    Ok(passages)
}

pub(in crate::cognition) fn meaning_prompt(
    input: &ExtractInput,
    passages: &[Passage],
) -> CognitionResult<Value> {
    let Some(first) = input.source_units.first() else {
        return Err(error("memory_extract_invalid_input"));
    };
    if input
        .source_units
        .iter()
        .any(|unit| unit.role != first.role)
    {
        return Err(error("memory_extract_mixed_source_roles"));
    }
    let parts = Value::Array(
        passages
            .iter()
            .map(|passage| {
                let mut part = serde_json::Map::new();
                part.insert("id".into(), json!(passage.id));
                part.insert("text".into(), json!(passage.text));
                if let (Some(before), Some(after)) = (&passage.before, &passage.after) {
                    part.insert("before".into(), json!(before));
                    part.insert("after".into(), json!(after));
                }
                Value::Object(part)
            })
            .collect(),
    );
    if crate::json::stringify(&parts).map_err(json_error)?.len() > 4096 {
        return Err(error("memory_extract_source_window_exceeds_budget"));
    }
    let mut context = Vec::new();
    for unit in input
        .context_units
        .iter()
        .rev()
        .filter(|unit| unit.source_span.is_none())
    {
        let item = json!({"text":unit.text,"basis":unit.basis});
        let candidate_context = context
            .clone()
            .into_iter()
            .chain([item.clone()])
            .collect::<Vec<_>>();
        let candidate = json!({"parts":parts,"context":candidate_context});
        if crate::json::stringify(&candidate)
            .map_err(json_error)?
            .len()
            <= 4096
        {
            context.insert(0, item);
        }
    }
    Ok(
        json!({"speaker":first.role,"observed_at":first.observed_at,"parts":parts,"context":context}),
    )
}

pub(in crate::cognition) fn validate_meaning(
    value: Value,
    passages: &[Passage],
) -> CognitionResult<Meaning> {
    validation::validate(value, passages)
}

pub(in crate::cognition) fn meaning_to_output(
    input: &ExtractInput,
    meaning: &Meaning,
    passages: &[Passage],
) -> CognitionResult<ExtractOutput> {
    if meaning.status != "processed" {
        return Err(error(if meaning.status == "needs_context" {
            "memory_extract_needs_context"
        } else {
            "memory_extract_unsupported"
        }));
    }
    let scope = if input.bound_project_id.is_some() {
        "project"
    } else {
        "user"
    };
    let create = || NodeResolution::Create {
        provisional: true,
        identity_scope: scope.into(),
    };
    let quotes = |value: &Value| -> CognitionResult<Vec<QuoteRef>> {
        value
            .as_array()
            .ok_or_else(|| error("memory_extract_invalid_evidence"))?
            .iter()
            .map(|x| {
                passages
                    .get(x.as_f64().unwrap_or(f64::NAN) as usize)
                    .map(|p| p.quote.clone())
                    .ok_or_else(|| error("memory_extract_invalid_evidence"))
            })
            .collect()
    };
    let mut nodes = meaning
        .entities
        .iter()
        .enumerate()
        .map(|(i, e)| {
            Ok(ExtractNode {
                local_ref: format!("n{i}"),
                node_type: "entity".into(),
                label: e.name.clone(),
                resolution: create(),
                aliases: Vec::new(),
                evidence: e
                    .evidence
                    .iter()
                    .map(|x| passages[*x as usize].quote.clone())
                    .collect(),
            })
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    let mut claims = Vec::new();
    let mut relations = Vec::new();
    for (i, item) in meaning.items.iter().enumerate() {
        let o = item
            .as_object()
            .ok_or_else(|| error("memory_extract_invalid_meaning"))?;
        let kind = o
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| error("memory_extract_invalid_meaning"))?;
        let evidence = quotes(o.get("evidence").unwrap_or(&Value::Null))?;
        let subject = o
            .get("subject")
            .or_else(|| o.get("from"))
            .and_then(Value::as_f64)
            .map(|x| format!("n{}", x as usize));
        let relation = matches!(kind, "relation" | "not_relation");
        let statement = o
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                evidence
                    .iter()
                    .map(|x| x.quote.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            });
        let local_ref = format!("f{i}");
        claims.push(ExtractClaim {
            local_ref: local_ref.clone(),
            claim_type: match kind {
                "preference" | "goal" | "decision" => kind.into(),
                "requires" => "constraint".into(),
                _ => "memory_atom".into(),
            },
            resolution: create(),
            statement,
            subject_ref: subject.clone(),
            object_ref: if relation {
                o.get("to")
                    .and_then(Value::as_f64)
                    .map(|x| format!("n{}", x as usize))
            } else {
                None
            },
            speech_act: match kind {
                "request" | "question" | "proposal" => kind.into(),
                _ => "assertion".into(),
            },
            basis: if kind == "inference" {
                "inference".into()
            } else {
                basis(&input.source_units[0].role).into()
            },
            polarity: if kind == "not_relation" {
                "negative".into()
            } else {
                "positive".into()
            },
            condition: None,
            requirement: if kind == "requires" {
                Some(json!({"action":o.get("action").and_then(Value::as_str),
                    "condition":validation::map_condition(o.get("condition").ok_or_else(||error("memory_extract_invalid_condition"))?)}))
            } else {
                None
            },
            valid_from: None,
            valid_to: None,
            salience: "normal".into(),
            evidence: evidence.clone(),
        });
        if relation {
            relations.push(ExtractRelation {
                from_ref: subject.ok_or_else(|| error("memory_extract_invalid_ref"))?,
                to_ref: o
                    .get("to")
                    .and_then(Value::as_f64)
                    .map(|x| format!("n{}", x as usize))
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?,
                relation: o
                    .get("predicate")
                    .and_then(Value::as_str)
                    .unwrap_or("related_to")
                    .into(),
                claim_ref: local_ref,
                evidence,
            });
        }
    }
    for attribute in &meaning.attributes {
        let o = attribute
            .as_object()
            .ok_or_else(|| error("memory_extract_invalid_output"))?;
        match o.get("kind").and_then(Value::as_str) {
            Some("alias") => {
                let index = o
                    .get("entity")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?
                    as usize;
                let text = o
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("memory_extract_invalid_output"))?
                    .to_owned();
                let evidence = quotes(o.get("evidence").unwrap_or(&Value::Null))?;
                nodes
                    .get_mut(index)
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?
                    .aliases
                    .push(ExtractAlias { text, evidence });
            }
            Some("importance") => {
                let index = o
                    .get("item")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?
                    as usize;
                claims
                    .get_mut(index)
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?
                    .salience = "high".into();
            }
            Some("validity") => {
                let index = o
                    .get("item")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?
                    as usize;
                let claim = claims
                    .get_mut(index)
                    .ok_or_else(|| error("memory_extract_invalid_ref"))?;
                claim.valid_from = o.get("from").and_then(Value::as_str).map(str::to_owned);
                claim.valid_to = o.get("to").and_then(Value::as_str).map(str::to_owned);
            }
            _ => return Err(error("memory_extract_invalid_output")),
        }
    }
    Ok(ExtractOutput {
        schema: "butler.memory-extract-output.v3".into(),
        window_ref: input.window_ref.clone(),
        disposition: "processed".into(),
        covered_unit_refs: input
            .source_units
            .iter()
            .map(|x| x.ref_id.clone())
            .collect(),
        nodes,
        claims,
        relations,
        corrections: Vec::new(),
        summary: None,
    })
}
fn basis(role: &str) -> &'static str {
    match role {
        "user" | "explicit" => "user_statement",
        "assistant" => "assistant_statement",
        "task" => "reviewed_task",
        _ => "inference",
    }
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
