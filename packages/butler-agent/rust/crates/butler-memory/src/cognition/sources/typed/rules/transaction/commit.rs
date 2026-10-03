//! Recoverable rule commit, archive and typed source exclusion.
use super::*;

pub(super) fn complete(
    owner: &RememberedRuleOwner,
    intent: &Intent,
) -> CognitionResult<RememberedRuleReceipt> {
    let root = owner.root();
    authorize(owner, intent, &root)?;
    butler_platform::secure_fs::create_private_dir_all(&root.join("handles"))
        .map_err(failure_source)?;
    write_json(
        &root
            .join("handles")
            .join(format!("{}.json", intent.entry.handle)),
        &intent.entry,
    )?;
    archive(&root, intent)?;
    owner.checkpoint("archive", operation_id(&intent.request))?;
    super::super::super::write::write_atomic(
        &root.join(format!("{}.md", intent.entry.record_id)),
        intent.text.as_bytes(),
    )?;
    write_json(
        &root.join(format!("{}.source.json", intent.entry.record_id)),
        &intent.binding,
    )?;
    owner.checkpoint("source", operation_id(&intent.request))?;
    exclude(owner, intent)?;
    owner.checkpoint("graph", operation_id(&intent.request))?;
    write_index(&root, intent)?;
    write_json(&root.join("manifest.json"), &intent.inventory)?;
    owner.checkpoint("index", operation_id(&intent.request))?;
    let notice = crate::cognition::TypedMemorySourceNotice::ExplicitRule {
        record_id: intent.entry.record_id.clone(),
        revision: intent.binding.revision.clone(),
        operation_id: intent.binding.operation_id.clone(),
    };
    // Temporary and session instructions apply only through Active Rules.
    // They never enter semantic recall, where an expired mandate could linger.
    if intent.entry.expires_at.is_none() && intent.entry.scope_session_id.is_none() {
        owner.publisher.publish_typed_source(&notice)?;
    }
    owner.checkpoint("notice", operation_id(&intent.request))?;
    receipt(owner, intent, &root)
}

fn receipt(
    owner: &RememberedRuleOwner,
    intent: &Intent,
    root: &std::path::Path,
) -> CognitionResult<RememberedRuleReceipt> {
    let result = RememberedRuleReceipt {
        rule: intent.entry.handle.clone(),
        operation_id: intent.binding.operation_id.clone(),
        state: intent.binding.state.clone(),
        replayed: false,
        recall_state: (intent.entry.state == "active").then(|| "pending".into()),
    };
    write_json(
        &root
            .join("operations")
            .join(format!("{}.json", sha256(result.operation_id.as_bytes()))),
        &Receipt {
            request: intent.request.clone(),
            result: result.clone(),
        },
    )?;
    owner.checkpoint("receipt", operation_id(&intent.request))?;
    fs::remove_file(root.join("pending.json")).map_err(failure_source)?;
    butler_platform::secure_fs::sync_path(root).map_err(failure_source)?;
    Ok(result)
}

fn archive(root: &std::path::Path, intent: &Intent) -> CognitionResult<()> {
    let Some(text) = &intent.previous_text else {
        return Ok(());
    };
    let path = root.join("archive").join(&intent.entry.record_id);
    butler_platform::secure_fs::create_private_dir_all(&path).map_err(failure_source)?;
    let revision = prior_revision(intent)
        .map(str::to_owned)
        .unwrap_or_else(|| sha256(text.as_bytes()));
    write_json(
        &path.join(format!("{revision}.json")),
        &serde_json::json!({
            "text":text, "binding":intent.previous, "revision":revision,
        }),
    )
}

fn write_index(root: &std::path::Path, intent: &Intent) -> CognitionResult<()> {
    let filename = format!("{}.md", intent.entry.record_id);
    let prior = match fs::read_to_string(root.join("INDEX.md")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(failure_source(error)),
    };
    let replacement = format!(
        "- [{}]({filename})",
        super::super::super::write::compact(&intent.text, 80)
    );
    let mut found = false;
    let mut lines = Vec::new();
    for line in prior.lines() {
        if line.contains(&format!("]({filename})")) {
            if !found && intent.entry.state == "active" {
                lines.push(replacement.clone());
            }
            found = true;
        } else {
            lines.push(line.to_owned());
        }
    }
    if !found && intent.entry.state == "active" {
        lines.push(replacement);
    }
    super::super::super::write::write_atomic(
        &root.join("INDEX.md"),
        format!("{}\n", lines.join("\n")).as_bytes(),
    )
}

/// Apply source lifecycle before acknowledging the saved operation.
fn exclude(owner: &RememberedRuleOwner, intent: &Intent) -> CognitionResult<()> {
    use crate::cognition::graph::{GraphRepository, TypedLifecycleInput};
    use crate::cognition::sources::TypedMemoryLifecycle;
    let forgotten = intent.binding.state == "forgotten";
    let revision = if forgotten {
        intent.binding.revision.as_str()
    } else if let Some(revision) = prior_revision(intent) {
        revision
    } else {
        return Ok(());
    };
    let legacy_operation = format!("legacy-rule:{}:{revision}", intent.entry.record_id);
    let operation = if forgotten {
        intent.binding.operation_id.as_str()
    } else {
        intent
            .previous
            .as_ref()
            .map(|binding| binding.operation_id.as_str())
            .unwrap_or(&legacy_operation)
    };
    let generation = resolve_active_generation(&owner.data_root, &owner.environment)?;
    ensure_data_authority(&owner.data_root, &[&generation.graph_path])?;
    let mut graph = GraphRepository::open(&generation.graph_path)?;
    let consumed = graph.consume_typed_lifecycle(TypedLifecycleInput {
        source_kind: "explicit_record",
        record_id: &intent.entry.record_id,
        revision,
        operation_id: operation,
        disposition: if forgotten {
            TypedMemoryLifecycle::Forgotten
        } else {
            TypedMemoryLifecycle::Superseded
        },
        now: &owner.publisher.now_iso(),
    });
    let closed = graph.close();
    consumed.and(closed)?;
    // An already acknowledged old observation must be explicitly republished.
    if let Some(prior) = &intent.previous {
        owner.publisher.publish_typed_source(
            &crate::cognition::TypedMemorySourceNotice::ExplicitRule {
                record_id: prior.record_id.clone(),
                revision: prior.revision.clone(),
                operation_id: prior.operation_id.clone(),
            },
        )?;
    }
    Ok(())
}
fn authorize(
    owner: &RememberedRuleOwner,
    intent: &Intent,
    root: &std::path::Path,
) -> CognitionResult<()> {
    ensure_data_authority(
        &owner.data_root,
        &[
            &root.join("archive").join(&intent.entry.record_id),
            &root
                .join("handles")
                .join(format!("{}.json", intent.entry.handle)),
            &root.join("operations"),
            &root.join("pending.json"),
            &root.join("manifest.json"),
            &root.join("INDEX.md"),
            &root.join(format!("{}.md", intent.entry.record_id)),
            &root.join(format!("{}.source.json", intent.entry.record_id)),
        ],
    )
}

/// Older global rules have no binding file; their authorised snapshot carries
/// the exact revision that must be archived and retired.
fn prior_revision(intent: &Intent) -> Option<&str> {
    intent
        .previous
        .as_ref()
        .map(|binding| binding.revision.as_str())
        .or_else(|| match &intent.request {
            Request::Remember { target, .. } => target
                .as_ref()
                .map(|target| target.expected_revision.as_str()),
            Request::Forget { target, .. } => Some(target.expected_revision.as_str()),
        })
}
