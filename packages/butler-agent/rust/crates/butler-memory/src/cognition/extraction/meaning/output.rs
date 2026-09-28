//! `Meaning` -> graph facts: entities become create-nodes `n{i}`, items become
//! claims `f{i}` (plus relations), and attributes annotate them.

use super::{
    Meaning, MeaningAttribute, MeaningCondition, MeaningItem, MeaningStatus, Passage, error,
};
use crate::cognition::extraction::{
    ClaimCondition, ClaimRequirement, ExtractAlias, ExtractClaim, ExtractInput, ExtractNode,
    ExtractOutput, ExtractRelation, NodeResolution, QuoteRef,
};
use crate::cognition::{CognitionCode, CognitionResult};

/// Graph facts proposed by a processed meaning; binding may later reuse
/// existing nodes for them.
pub(in crate::cognition) fn meaning_to_output(
    input: &ExtractInput,
    meaning: &Meaning,
    passages: &[Passage],
) -> CognitionResult<ExtractOutput> {
    match meaning.status {
        MeaningStatus::Processed => {}
        MeaningStatus::NeedsContext => {
            return Err(error(CognitionCode::MemoryExtractNeedsContext));
        }
        MeaningStatus::Unsupported => return Err(error(CognitionCode::MemoryExtractUnsupported)),
    }
    let facts = Facts {
        input,
        passages,
        scope: if input.bound_project_id.is_some() {
            "project"
        } else {
            "user"
        },
    };
    let mut nodes = facts.nodes(meaning)?;
    let (mut claims, relations) = facts.claims(meaning)?;
    for attribute in &meaning.attributes {
        annotate(attribute, &mut nodes, &mut claims, passages)?;
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

/// What every fact of one window shares.
struct Facts<'a> {
    input: &'a ExtractInput,
    passages: &'a [Passage],
    scope: &'static str,
}

impl Facts<'_> {
    fn create(&self) -> NodeResolution {
        NodeResolution::Create {
            provisional: true,
            identity_scope: self.scope.into(),
        }
    }

    /// One entity node `n{i}` per meaning entity.
    fn nodes(&self, meaning: &Meaning) -> CognitionResult<Vec<ExtractNode>> {
        meaning
            .entities
            .iter()
            .enumerate()
            .map(|(i, entity)| {
                Ok(ExtractNode {
                    local_ref: format!("n{i}"),
                    node_type: "entity".into(),
                    label: entity.name.clone(),
                    resolution: self.create(),
                    aliases: Vec::new(),
                    evidence: quotes(&entity.evidence, self.passages)?,
                })
            })
            .collect()
    }

    /// One claim `f{i}` per item; relation items also add a relation edge.
    fn claims(
        &self,
        meaning: &Meaning,
    ) -> CognitionResult<(Vec<ExtractClaim>, Vec<ExtractRelation>)> {
        let mut claims = Vec::new();
        let mut relations = Vec::new();
        for (i, item) in meaning.items.iter().enumerate() {
            let claim = self.claim(format!("f{i}"), item)?;
            if let MeaningItem::Relation(relation) | MeaningItem::NotRelation(relation) = item {
                relations.push(ExtractRelation {
                    from_ref: claim
                        .subject_ref
                        .clone()
                        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?,
                    to_ref: node_ref(relation.to),
                    relation: relation.predicate.as_str().into(),
                    claim_ref: claim.local_ref.clone(),
                    evidence: claim.evidence.clone(),
                });
            }
            claims.push(claim);
        }
        Ok((claims, relations))
    }

    fn claim(&self, local_ref: String, item: &MeaningItem) -> CognitionResult<ExtractClaim> {
        let kind = item.kind();
        let evidence = quotes(item.evidence(), self.passages)?;
        let statement = item.text().map_or_else(
            || {
                evidence
                    .iter()
                    .map(|x| x.quote.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            },
            str::to_owned,
        );
        let (object_ref, polarity) = match item {
            MeaningItem::Relation(relation) => (Some(node_ref(relation.to)), "positive"),
            MeaningItem::NotRelation(relation) => (Some(node_ref(relation.to)), "negative"),
            _ => (None, "positive"),
        };
        Ok(ExtractClaim {
            local_ref,
            claim_type: match item {
                MeaningItem::Preference(_) | MeaningItem::Goal(_) | MeaningItem::Decision(_) => {
                    kind.into()
                }
                MeaningItem::Requires(_) => "constraint".into(),
                _ => "memory_atom".into(),
            },
            resolution: self.create(),
            statement,
            subject_ref: item.subject().map(node_ref),
            object_ref,
            speech_act: match item {
                MeaningItem::Request(_) | MeaningItem::Question(_) | MeaningItem::Proposal(_) => {
                    kind.into()
                }
                _ => "assertion".into(),
            },
            basis: if matches!(item, MeaningItem::Inference(_)) {
                "inference".into()
            } else {
                basis(
                    self.input
                        .source_units
                        .first()
                        .map_or("", |unit| unit.role.as_str()),
                )
                .into()
            },
            polarity: polarity.into(),
            condition: None,
            requirement: match item {
                MeaningItem::Requires(requires) => Some(ClaimRequirement {
                    action: requires.action.clone(),
                    condition: claim_condition(&requires.condition),
                }),
                _ => None,
            },
            valid_from: None,
            valid_to: None,
            salience: "normal".into(),
            evidence,
        })
    }
}

impl MeaningItem {
    /// The contract's `kind` tag.
    pub(in crate::cognition) fn kind(&self) -> &'static str {
        match self {
            Self::Fact(_) => "fact",
            Self::Preference(_) => "preference",
            Self::Goal(_) => "goal",
            Self::Decision(_) => "decision",
            Self::Question(_) => "question",
            Self::Proposal(_) => "proposal",
            Self::Request(_) => "request",
            Self::Inference(_) => "inference",
            Self::Relation(_) => "relation",
            Self::NotRelation(_) => "not_relation",
            Self::Requires(_) => "requires",
            Self::Change(_) => "change",
        }
    }

    /// Passage ids supporting the item.
    pub(in crate::cognition) fn evidence(&self) -> &[usize] {
        match self {
            Self::Fact(item)
            | Self::Preference(item)
            | Self::Goal(item)
            | Self::Decision(item)
            | Self::Question(item)
            | Self::Proposal(item)
            | Self::Request(item)
            | Self::Inference(item) => &item.evidence,
            Self::Relation(item) | Self::NotRelation(item) => &item.evidence,
            Self::Requires(item) => &item.evidence,
            Self::Change(item) => &item.evidence,
        }
    }

    /// Entity index the item is about (a relation's `from`).
    pub(in crate::cognition) fn subject(&self) -> Option<usize> {
        match self {
            Self::Fact(item)
            | Self::Preference(item)
            | Self::Goal(item)
            | Self::Decision(item)
            | Self::Question(item)
            | Self::Proposal(item)
            | Self::Request(item)
            | Self::Inference(item) => item.subject,
            Self::Relation(item) | Self::NotRelation(item) => Some(item.from),
            Self::Requires(item) => Some(item.subject),
            Self::Change(item) => item.subject,
        }
    }

    /// The item's own statement text; other kinds quote their evidence.
    fn text(&self) -> Option<&str> {
        match self {
            Self::Fact(item)
            | Self::Preference(item)
            | Self::Goal(item)
            | Self::Decision(item)
            | Self::Question(item)
            | Self::Proposal(item)
            | Self::Request(item)
            | Self::Inference(item) => Some(&item.text),
            _ => None,
        }
    }
}

/// Applies one attribute: an alias to its entity node, or importance or
/// validity to its item's claim.
fn annotate(
    attribute: &MeaningAttribute,
    nodes: &mut [ExtractNode],
    claims: &mut [ExtractClaim],
    passages: &[Passage],
) -> CognitionResult<()> {
    let invalid_ref = || error(CognitionCode::MemoryExtractInvalidRef);
    match attribute {
        MeaningAttribute::Alias {
            entity,
            name,
            evidence,
        } => {
            let evidence = quotes(evidence, passages)?;
            nodes
                .get_mut(*entity)
                .ok_or_else(invalid_ref)?
                .aliases
                .push(ExtractAlias {
                    text: name.clone(),
                    evidence,
                });
        }
        MeaningAttribute::Importance { item } => {
            claims.get_mut(*item).ok_or_else(invalid_ref)?.salience = "high".into();
        }
        MeaningAttribute::Validity { item, from, to } => {
            let claim = claims.get_mut(*item).ok_or_else(invalid_ref)?;
            claim.valid_from.clone_from(from);
            claim.valid_to.clone_from(to);
        }
    }
    Ok(())
}

/// The quotes of passage ids; an unknown id is invalid evidence.
fn quotes(ids: &[usize], passages: &[Passage]) -> CognitionResult<Vec<QuoteRef>> {
    ids.iter()
        .map(|id| {
            passages
                .get(*id)
                .map(|passage| passage.quote.clone())
                .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidEvidence))
        })
        .collect()
}

/// The condition with entity indexes replaced by their node refs.
fn claim_condition(condition: &MeaningCondition) -> ClaimCondition {
    match condition {
        MeaningCondition::Atom { subject, state } => ClaimCondition::Atom {
            subject: subject.map(node_ref),
            state: state.clone(),
        },
        MeaningCondition::Not { not } => ClaimCondition::Not {
            not: Box::new(claim_condition(not)),
        },
        MeaningCondition::All { all } => ClaimCondition::All {
            all: all.iter().map(claim_condition).collect(),
        },
        MeaningCondition::Any { any } => ClaimCondition::Any {
            any: any.iter().map(claim_condition).collect(),
        },
    }
}

fn node_ref(index: usize) -> String {
    format!("n{index}")
}

fn basis(role: &str) -> &'static str {
    match role {
        "user" | "explicit" => "user_statement",
        "assistant" => "assistant_statement",
        "task" => "reviewed_task",
        _ => "inference",
    }
}
