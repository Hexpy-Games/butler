use super::*;
use crate::btcc::BtccError;
use std::collections::{HashMap, HashSet, VecDeque};

pub(crate) fn check(valid: bool, code: &str) -> Result<(), BtccError> {
    if valid { Ok(()) } else { Err(error(code)) }
}

pub(crate) fn text(value: &str) -> Result<(), BtccError> {
    check(!value.trim().is_empty(), "work_model_text_required")
}

pub(crate) fn validate_bundle(bundle: &InitialBundle) -> Result<(), BtccError> {
    text(&bundle.goal)?;
    check(!bundle.nodes.is_empty(), "spec_required")?;
    check(!bundle.works.is_empty(), "work_required")?;
    check((1..=2).contains(&bundle.tier), "tier_invalid")?;
    let nodes = validate_tree(&bundle.nodes, &bundle.root_node_id)?;
    if bundle.tier == 1 {
        let brief = bundle.nodes.first().ok_or_else(|| error("spec_required"))?;
        check(
            bundle.nodes.len() == 1 && brief.kind == SpecKind::Brief,
            "tier_one_requires_one_brief",
        )?;
        check(
            (2..=3).contains(&brief.criteria.len()),
            "brief_criteria_invalid",
        )?;
        check(bundle.tasks.len() <= 5, "tier_escalation_required")?;
    } else {
        check(
            bundle.nodes.iter().all(|node| node.kind != SpecKind::Brief),
            "full_spec_required",
        )?;
    }
    let mut works = HashMap::new();
    for work in &bundle.works {
        text(&work.key)?;
        text(&work.outcome)?;
        check(
            works.insert(&work.key, work).is_none(),
            "work_key_duplicate",
        )?;
        binding(&nodes, &work.node_id, &work.part_ids, &work.criterion_ids)?;
    }
    let mut tasks = HashSet::new();
    for task in &bundle.tasks {
        text(&task.key)?;
        text(&task.description)?;
        check(tasks.insert(task.key.clone()), "task_key_duplicate")?;
        let work = works
            .get(&task.work_key)
            .ok_or_else(|| error("task_work_invalid"))?;
        check(
            descendant(&nodes, &task.node_id, &work.node_id),
            "task_spec_outside_work",
        )?;
        binding(&nodes, &task.node_id, &task.part_ids, &task.criterion_ids)?;
    }
    let edges = bundle
        .tasks
        .iter()
        .flat_map(|task| {
            task.after
                .iter()
                .map(move |from| (from.clone(), task.key.clone()))
        })
        .collect::<Vec<_>>();
    dag(&tasks, &edges)
}

fn validate_tree<'a>(
    drafts: &'a [SpecDraft],
    root: &str,
) -> Result<HashMap<String, &'a SpecDraft>, BtccError> {
    let mut nodes = HashMap::new();
    let mut concerns = HashSet::new();
    for node in drafts {
        text(&node.node_id)?;
        text(&node.concern_id)?;
        text(&node.responsibility)?;
        check(node.node_revision == 1, "in_use_spec_replan_unavailable")?;
        check(
            nodes.insert(node.node_id.clone(), node).is_none(),
            "spec_node_duplicate",
        )?;
        check(concerns.insert(&node.concern_id), "spec_concern_conflict")?;
        validate_node(node)?;
    }
    check(
        nodes.get(root).is_some_and(|n| n.parent_id.is_none()),
        "spec_root_invalid",
    )?;
    let mut edges = Vec::new();
    for node in drafts {
        if let Some(parent) = &node.parent_id {
            edges.push((parent.clone(), node.node_id.clone()));
        } else {
            check(node.node_id == root, "spec_tree_multiple_roots")?;
        }
        validate_coverage(node, &nodes)?;
    }
    dag(&nodes.keys().cloned().collect(), &edges)?;
    Ok(nodes)
}

fn validate_node(node: &SpecDraft) -> Result<(), BtccError> {
    check(
        !node.parts.is_empty() && !node.criteria.is_empty(),
        "spec_content_required",
    )?;
    let mut parts = HashSet::new();
    for part in &node.parts {
        text(&part.id)?;
        text(&part.behaviour)?;
        check(parts.insert(&part.id), "spec_part_duplicate")?;
        if node.kind != SpecKind::Brief {
            text(&part.design)?;
            text(&part.implementation)?;
        }
    }
    let mut criteria = HashSet::new();
    for criterion in &node.criteria {
        text(&criterion.id)?;
        text(&criterion.text)?;
        check(
            criteria.insert(&criterion.id) && parts.contains(&criterion.part_id),
            "spec_criterion_invalid",
        )?;
        if node.kind != SpecKind::Brief {
            text(&criterion.verification)?;
        }
    }
    if node.kind == SpecKind::Research {
        let method = node
            .research_method
            .as_ref()
            .ok_or_else(|| error("research_method_required"))?;
        check(
            !method.questions.is_empty() && !method.hypotheses.is_empty(),
            "research_method_required",
        )?;
        for value in method
            .questions
            .iter()
            .chain(&method.hypotheses)
            .map(String::as_str)
            .chain([
                method.method.as_str(),
                &method.variables_controls,
                &method.sampling_sources,
                &method.analysis,
                &method.falsification,
            ])
        {
            text(value)?;
        }
    }

    Ok(())
}

fn binding(
    nodes: &HashMap<String, &SpecDraft>,
    node_id: &str,
    parts: &[String],
    criteria: &[String],
) -> Result<(), BtccError> {
    let node = nodes
        .get(node_id)
        .ok_or_else(|| error("spec_binding_invalid"))?;
    check(
        !parts.is_empty() && !criteria.is_empty(),
        "criterion_binding_required",
    )?;
    let unique_parts: HashSet<_> = parts.iter().collect();
    let unique_criteria: HashSet<_> = criteria.iter().collect();
    check(
        unique_parts.len() == parts.len() && unique_criteria.len() == criteria.len(),
        "binding_duplicate",
    )?;
    check(
        parts
            .iter()
            .all(|id| node.parts.iter().any(|p| &p.id == id)),
        "part_binding_invalid",
    )?;
    check(
        criteria.iter().all(|id| {
            node.criteria
                .iter()
                .any(|c| &c.id == id && parts.contains(&c.part_id))
        }),
        "criterion_binding_invalid",
    )
}

fn descendant(nodes: &HashMap<String, &SpecDraft>, child: &str, ancestor: &str) -> bool {
    let mut current = Some(child);
    for _ in 0..=nodes.len() {
        let Some(id) = current else {
            return false;
        };
        if id == ancestor {
            return true;
        }
        current = nodes.get(id).and_then(|n| n.parent_id.as_deref());
    }
    false
}

/// Kahn's algorithm validates the complete affected Plan, including fan-out/join.
pub(crate) fn dag(nodes: &HashSet<String>, edges: &[(String, String)]) -> Result<(), BtccError> {
    let mut degrees: HashMap<&str, usize> = nodes.iter().map(|n| (n.as_str(), 0)).collect();
    let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut seen = HashSet::new();
    for (from, to) in edges {
        check(
            from != to && nodes.contains(from) && nodes.contains(to),
            "dependency_invalid",
        )?;
        check(seen.insert((from, to)), "dependency_duplicate")?;
        *degrees
            .get_mut(to.as_str())
            .ok_or_else(|| error("dependency_invalid"))? += 1;
        successors.entry(from).or_default().push(to);
    }
    let mut ready: VecDeque<_> = degrees
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(n, _)| *n)
        .collect();
    let mut visited = 0;
    while let Some(node) = ready.pop_front() {
        visited += 1;
        for successor in successors.get(node).into_iter().flatten() {
            let degree = degrees
                .get_mut(successor)
                .ok_or_else(|| error("dependency_invalid"))?;
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(*successor);
            }
        }
    }
    check(visited == nodes.len(), "dependency_cycle")
}

fn validate_coverage(
    node: &SpecDraft,
    nodes: &HashMap<String, &SpecDraft>,
) -> Result<(), BtccError> {
    let mut groups = HashMap::new();
    let mut mappings = HashSet::new();
    for mapping in &node.child_coverage {
        check(
            mappings.insert((
                &mapping.criterion_id,
                &mapping.child_node_id,
                &mapping.child_criterion_id,
            )),
            "coverage_duplicate",
        )?;
        check(
            groups
                .insert(&mapping.criterion_id, mapping.semantics)
                .is_none_or(|s| s == mapping.semantics),
            "coverage_semantics_conflict",
        )?;
        if mapping.semantics == CoverageSemantics::Any {
            text(&mapping.justification)?;
        }
        let child = nodes
            .get(&mapping.child_node_id)
            .ok_or_else(|| error("coverage_invalid"))?;
        check(
            child.parent_id.as_deref() == Some(node.node_id.as_str())
                && node.criteria.iter().any(|c| c.id == mapping.criterion_id)
                && child
                    .criteria
                    .iter()
                    .any(|c| c.id == mapping.child_criterion_id),
            "coverage_invalid",
        )?;
    }
    Ok(())
}
