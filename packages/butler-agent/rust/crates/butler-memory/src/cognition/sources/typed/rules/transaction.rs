//! A single lease-serialized pending intent, with per-operation durable receipts.
use super::inventory::{Entry, read_json, write_json};
use super::*;
use std::fs;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) enum Request {
    Remember {
        input: ExplicitMemoryUpdateInput,
        target: Option<RememberedRuleTarget>,
    },
    Forget {
        target: RememberedRuleTarget,
        operation_id: String,
        conversation_session_id: Option<String>,
        conversation_message_id: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Intent {
    request: Request,
    pub entry: Entry,
    text: String,
    binding: ExplicitRuleBinding,
    previous: Option<ExplicitRuleBinding>,
    previous_text: Option<String>,
    inventory: Inventory,
}

#[derive(Deserialize, Serialize)]
struct Receipt {
    request: Request,
    result: RememberedRuleReceipt,
}

pub(super) fn run(
    owner: &RememberedRuleOwner,
    request: Option<Request>,
) -> CognitionResult<Option<RememberedRuleReceipt>> {
    let root = owner.root();
    if let Some(pending) = read_json::<Intent>(&root.join("pending.json"))? {
        complete(owner, &pending)?;
    }
    let Some(request) = request else {
        return Ok(None);
    };
    let operation = operation_id(&request);
    if operation.is_empty() {
        return Err(failure("rule_operation_required"));
    }
    let path = root
        .join("operations")
        .join(format!("{}.json", sha256(operation.as_bytes())));
    if let Some(receipt) = read_json::<Receipt>(&path)? {
        if serde_json::to_value(&receipt.request).map_err(failure_source)?
            != serde_json::to_value(&request).map_err(failure_source)?
        {
            return Err(failure("rule_operation_conflict"));
        }
        return Ok(Some(RememberedRuleReceipt {
            replayed: true,
            ..receipt.result
        }));
    }
    let intent = prepare(owner, request)?;
    ensure_data_authority(
        &owner.data_root,
        &[&root.join("operations"), &root.join("pending.json")],
    )?;
    fs::create_dir_all(root.join("operations")).map_err(failure_source)?;
    butler_platform::secure_fs::sync_path(&root).map_err(failure_source)?;
    write_json(&root.join("pending.json"), &intent)?;
    complete(owner, &intent).map(Some)
}

fn operation_id(request: &Request) -> &str {
    match request {
        Request::Remember { input, .. } => input.operation_id.as_deref().unwrap_or(""),
        Request::Forget { operation_id, .. } => operation_id,
    }
}

fn prepare(owner: &RememberedRuleOwner, request: Request) -> CognitionResult<Intent> {
    let root = owner.root();
    let mut inventory = Inventory::read(&root)?;
    let target = match &request {
        Request::Remember { target, .. } => target.as_ref(),
        Request::Forget { target, .. } => Some(target),
    };
    let entry = target
        .map(|target| select(&inventory, target, &request))
        .transpose()?;
    let id = entry
        .as_ref()
        .map(|r| r.record_id.clone())
        .unwrap_or_else(|| sha256(format!("explicit-rule:{}", operation_id(&request)).as_bytes()));
    let previous = read_binding(&owner.environment.memory_root(&owner.data_root), &id)?;
    let previous_text = entry
        .as_ref()
        .map(|_| fs::read_to_string(root.join(format!("{id}.md"))).map_err(failure_source))
        .transpose()?;
    let binding = binding(
        owner,
        &request,
        &id,
        previous.as_ref(),
        previous_text.as_deref(),
    )?;
    let text = match &request {
        Request::Remember { input, .. } => input.text.clone(),
        Request::Forget { .. } => previous_text
            .clone()
            .ok_or_else(|| failure("rule_text_missing"))?,
    };
    let entry = Entry {
        handle: entry.map(|r| r.handle).unwrap_or(inventory.allocate(&id)?),
        record_id: id,
        revision: binding.revision.clone(),
        content_hash: binding.content_hash.clone(),
        project_id: binding.project_id.clone(),
        state: binding.state.clone(),
    };
    inventory.put(entry.clone());
    Ok(Intent {
        request,
        entry,
        text,
        binding,
        previous,
        previous_text,
        inventory,
    })
}

fn binding(
    owner: &RememberedRuleOwner,
    request: &Request,
    id: &str,
    previous: Option<&ExplicitRuleBinding>,
    previous_text: Option<&str>,
) -> CognitionResult<ExplicitRuleBinding> {
    let (text, project, session, message, state) = match request {
        Request::Remember { input, .. } => {
            if input.text.trim().is_empty() {
                return Err(failure("rule_text_required"));
            }
            (
                &*input.text,
                input.project_id.clone(),
                input.conversation_session_id.clone(),
                input.conversation_message_id.clone(),
                "active",
            )
        }
        Request::Forget {
            target,
            conversation_session_id,
            conversation_message_id,
            ..
        } => (
            previous_text.unwrap_or(""),
            target.project_id.clone(),
            conversation_session_id.clone(),
            conversation_message_id.clone(),
            "forgotten",
        ),
    };
    if previous.is_some_and(|b| b.project_id != project) {
        return Err(failure("rule_binding_mismatch"));
    }
    let hash = sha256(text.as_bytes());
    let revision = revision(
        id,
        &hash,
        project.as_deref(),
        session.as_deref(),
        message.as_deref(),
        operation_id(request),
        state,
    )?;
    let mut operations = previous.map(|b| b.operations.clone()).unwrap_or_default();
    operations.push(RuleOperation {
        operation_id: operation_id(request).into(),
        revision: revision.clone(),
        state: if state == "active" {
            "written"
        } else {
            "forgotten"
        }
        .into(),
    });
    Ok(ExplicitRuleBinding {
        schema: "butler.explicit-rule-binding.v1".into(),
        state: state.into(),
        record_id: id.into(),
        revision,
        operation_id: operation_id(request).into(),
        content_hash: hash,
        project_id: project,
        conversation_session_id: session,
        conversation_message_id: message,
        observed_at: owner.publisher.now_iso(),
        operations,
    })
}

fn complete(
    owner: &RememberedRuleOwner,
    intent: &Intent,
) -> CognitionResult<RememberedRuleReceipt> {
    let root = owner.root();
    ensure_data_authority(
        &owner.data_root,
        &[
            &root.join("archive").join(&intent.entry.record_id),
            &root.join("operations"),
            &root.join("pending.json"),
            &root.join("manifest.json"),
            &root.join("INDEX.md"),
            &root.join(format!("{}.md", intent.entry.record_id)),
            &root.join(format!("{}.source.json", intent.entry.record_id)),
        ],
    )?;
    archive(&root, intent)?;
    super::super::write::write_atomic(
        &root.join(format!("{}.md", intent.entry.record_id)),
        intent.text.as_bytes(),
    )?;
    write_json(
        &root.join(format!("{}.source.json", intent.entry.record_id)),
        &intent.binding,
    )?;
    write_index(&root, intent)?;
    write_json(&root.join("manifest.json"), &intent.inventory)?;
    let notice = crate::cognition::TypedMemorySourceNotice::ExplicitRule {
        record_id: intent.entry.record_id.clone(),
        revision: intent.binding.revision.clone(),
        operation_id: intent.binding.operation_id.clone(),
    };
    owner.publisher.publish_typed_source(&notice)?;
    let result = RememberedRuleReceipt {
        rule: intent.entry.handle.clone(),
        operation_id: intent.binding.operation_id.clone(),
        state: intent.binding.state.clone(),
        replayed: false,
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
    fs::remove_file(root.join("pending.json")).map_err(failure_source)?;
    butler_platform::secure_fs::sync_path(&root).map_err(failure_source)?;
    Ok(result)
}

fn archive(root: &std::path::Path, intent: &Intent) -> CognitionResult<()> {
    let Some(text) = &intent.previous_text else {
        return Ok(());
    };
    let path = root.join("archive").join(&intent.entry.record_id);
    fs::create_dir_all(&path).map_err(failure_source)?;
    let revision = intent
        .previous
        .as_ref()
        .map(|b| b.revision.clone())
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
    let prior = fs::read_to_string(root.join("INDEX.md")).unwrap_or_default();
    let replacement = format!(
        "- [{}]({filename})",
        super::super::write::compact(&intent.text, 80)
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
    super::super::write::write_atomic(
        &root.join("INDEX.md"),
        format!("{}\n", lines.join("\n")).as_bytes(),
    )
}

fn revision(
    id: &str,
    hash: &str,
    project: Option<&str>,
    session: Option<&str>,
    message: Option<&str>,
    operation: &str,
    state: &str,
) -> CognitionResult<String> {
    Ok(sha256(
        format!(
            "{}:{operation}:{state}",
            explicit_rule_revision(id, hash, project, session, message)?
        )
        .as_bytes(),
    ))
}

fn select(
    inventory: &Inventory,
    target: &RememberedRuleTarget,
    request: &Request,
) -> CognitionResult<Entry> {
    let entry = inventory
        .find(&target.handle)
        .ok_or_else(|| failure("rule_handle_unknown"))?;
    if entry.project_id != target.project_id {
        return Err(failure("rule_binding_mismatch"));
    }
    if entry.revision != target.expected_revision {
        return Err(failure("rule_revision_stale"));
    }
    if entry.state != "active" && matches!(request, Request::Remember { .. }) {
        return Err(failure("rule_forgotten"));
    }
    Ok(entry.clone())
}
