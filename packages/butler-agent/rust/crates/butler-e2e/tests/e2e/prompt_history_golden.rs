//! Every-turn parity projections. Normalization is restricted to time, temporary
//! sandbox paths and the live configuration hash. No identity/content stripping.
use super::*;
use sha2::{Digest, Sha256};

pub(super) fn capture(
    data: &std::path::Path,
    requests: &[Value],
    placeholders: &butler_e2e::e2e::sanitize::Placeholders,
) -> Result<Value, HarnessError> {
    let frames = requests
        .iter()
        .map(|request| capture_frame(data, request, placeholders))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"frames":frames,
        "wire_bytes":requests.iter().map(|r|serde_json::to_vec(r).unwrap().len()).sum::<usize>()}))
}

fn capture_frame(
    data: &std::path::Path,
    request: &Value,
    placeholders: &butler_e2e::e2e::sanitize::Placeholders,
) -> Result<Value, HarnessError> {
    let text = source(request);
    assert_canonical_history(data, text)?;
    let blocks = fingerprints(&blocks(text, placeholders));
    let instructions = normalize(request["instructions"].as_str().unwrap(), placeholders);
    let history = text
        .lines()
        .filter(|s| s.starts_with("user: ") || s.starts_with("butler: "))
        .map(fingerprint)
        .collect::<Vec<_>>();
    let sections = fingerprints(&loaded_sections(data, request, placeholders)?);
    Ok(json!({"sections":sections,"blocks":blocks,
        "instructions_sha256":format!("{:x}",Sha256::digest(instructions)),
        "tools_sha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&request["tools"])?)),
        "history":history}))
}

fn normalize(text: &str, paths: &butler_e2e::e2e::sanitize::Placeholders) -> String {
    paths
        .hide(text)
        .split_inclusive('\n')
        .map(|line| {
            for field in [
                "Current Time UTC:",
                "Current Local Time:",
                "Live Configuration Hash:",
            ] {
                if line.starts_with(field) {
                    let ending = if line.ends_with("\r\n") {
                        "\r\n"
                    } else if line.ends_with('\n') {
                        "\n"
                    } else {
                        ""
                    };
                    return format!("{field} {{{{PER_RUN}}}}{ending}");
                }
            }
            line.to_owned()
        })
        .collect::<String>()
}

fn blocks(text: &str, paths: &butler_e2e::e2e::sanitize::Placeholders) -> Value {
    let mut result = serde_json::Map::new();
    let markers = [
        ("scope", "Current scope:"),
        ("work", "## Current Work"),
        ("work-stream", "## Active Work State"),
        ("effects", "## Persistent effect facts for current Work"),
        ("attachments", "## User attachments"),
        (
            "project-sources",
            "Explicit user-selected project source snapshots.",
        ),
        (
            "prior-tools",
            "## Previously recorded tool calls for this turn",
        ),
        (
            "branch-seed",
            "This conversation was explicitly branched from another answer.",
        ),
        (
            "session-references",
            "Explicit user-selected conversation references (read context only;",
        ),
        (
            "delegated-tools",
            "Granted tools in this delegated session (complete callable set;",
        ),
        ("accepted-plan", "Accepted Project Ledger Plan:"),
        ("request", "User request:"),
        ("request", "## Current request"),
        ("request", "## Delegated result"),
        ("documents", "## Recent conversation and feedback"),
        ("documents", "## Required working context"),
        ("documents", "## Optional working context"),
    ];
    for (id, marker) in markers.iter().take(11) {
        let block = text
            .find(marker)
            .map(|start| {
                let tail = &text[start..];
                let end = markers
                    .iter()
                    .filter_map(|(_, next)| {
                        tail[marker.len()..]
                            .find(&format!("\n\n{next}"))
                            .map(|i| i + marker.len())
                    })
                    .min()
                    .unwrap_or(tail.len());
                normalize(tail[..end].trim(), paths)
            })
            .unwrap_or_default();
        result.insert((*id).into(), block.into());
    }
    let current = [
        "## Current request\n",
        "## Delegated result\nSteward:\n",
        "## Delegated result\nWorker:\n",
        "User request:\n",
    ]
    .iter()
    .find_map(|marker| {
        text.split_once(marker)
            .map(|(_, tail)| tail.split("\n\nCurrent scope:").next().unwrap().to_owned())
    })
    .unwrap_or_default();
    result.insert("current-request".into(), normalize(&current, paths).into());
    result.into()
}

pub(super) fn compare(case: &str, requests: &[Value]) -> Result<(), HarnessError> {
    let directory = butler_e2e::e2e::binary::crate_root().join("fixtures/prompt-history");
    let main: Vec<Value> =
        serde_json::from_slice(&std::fs::read(directory.join(format!("{case}.json")))?)?;
    assert_eq!(
        main.len(),
        requests.len(),
        "{case}: every turn must be covered"
    );
    for (index, (main, branch)) in main.iter().zip(requests).enumerate() {
        eprintln!(
            "PROMPT_PARITY case={case} turn={index} main_bytes={} branch_bytes={}",
            main["wire_bytes"], branch["wire_bytes"]
        );
        let main_frames = main["frames"].as_array().unwrap();
        let branch_frames = branch["frames"].as_array().unwrap();
        assert_eq!(
            main_frames.len(),
            branch_frames.len(),
            "{case} turn={index} every request"
        );
        for (round, (main, branch)) in main_frames.iter().zip(branch_frames).enumerate() {
            for field in ["sections", "blocks", "instructions_sha256", "tools_sha256"] {
                assert_eq!(
                    main[field], branch[field],
                    "{case} turn={index} round={round} section={field}"
                );
            }
            for line in branch["history"].as_array().unwrap() {
                assert!(
                    main["history"].as_array().unwrap().contains(line),
                    "{case} turn={index} round={round} history={line}"
                );
            }
        }
    }
    Ok(())
}

fn fingerprint(text: &str) -> Value {
    json!({"bytes":text.len(),"sha256":format!("{:x}",Sha256::digest(text))})
}

fn fingerprints(value: &Value) -> Value {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, text)| (id.clone(), fingerprint(text.as_str().unwrap())))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

fn loaded_sections(
    data: &std::path::Path,
    request: &Value,
    placeholders: &butler_e2e::e2e::sanitize::Placeholders,
) -> Result<Value, HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    let mut query =
        db.prepare("SELECT source_id,content FROM btcc_context_documents ORDER BY rowid DESC")?;
    let mut sections = serde_json::Map::new();
    let prompt = format!(
        "{}\n{}",
        request["instructions"].as_str().unwrap(),
        source(request)
    );
    for row in query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (id, content) = row?;
        if id == "recent-conversation" {
            continue;
        }
        let loaded = super::super::agent_context::loaded_excerpt(&id, &content, &prompt);
        let normalized = normalize(&loaded, placeholders);
        if sections
            .get(&id)
            .and_then(Value::as_str)
            .is_none_or(|old| old.len() < normalized.len())
        {
            sections.insert(id, normalized.into());
        }
    }
    Ok(Value::Object(sections))
}

pub(super) fn parity_case(
    s: &butler_e2e::e2e::scenario::Scenario,
    requests: &[Value],
    case: &str,
) -> Result<(), HarnessError> {
    let mut placeholders = butler_e2e::e2e::sanitize::Placeholders::default();
    placeholders.add("W", s.sandbox.workspace.display().to_string());
    placeholders.add("D", s.sandbox.data.display().to_string());
    placeholders.add("SANDBOX", s.sandbox.root.display().to_string());
    let captured = requests
        .iter()
        .map(|r| capture(&s.sandbox.data, std::slice::from_ref(r), &placeholders))
        .collect::<Result<Vec<_>, _>>()?;
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() == Ok("1") {
        let directory = std::env::var("BUTLER_PROMPT_CAPTURE_DIR").unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(format!("{case}.json")),
            serde_json::to_vec(&captured)?,
        )?;
    } else {
        compare(case, &captured)?;
    }
    Ok(())
}

fn assert_canonical_history(data: &std::path::Path, text: &str) -> Result<(), HarnessError> {
    use rusqlite::OptionalExtension;
    let db = Connection::open(data.join("runtime/conversation-store.sqlite"))?;
    let mut query = db.prepare(
        "SELECT outcome,generation,json_object( \
        'source_hash',source_hash,'request_message_id',request_message_id, \
        'public_assistant_message_id',public_assistant_message_id, \
        'evidence_refs',json(evidence_refs_json), \
        'unresolved_obligations',json(unresolved_obligations_json), \
        'continuation',json(COALESCE(continuation_json,'null')),'safe_code',safe_code) \
        FROM conversation_turn_outcomes WHERE turn_id=?1",
    )?;
    let lines: Vec<_> = text.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let Some(id) = line
            .strip_prefix("turn ")
            .and_then(|s| s.split_whitespace().next())
        else {
            continue;
        };
        let outcome = query
            .query_row([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .optional()?;
        if let Some((kind, generation, expected)) = outcome {
            let prefix = format!("outcome {kind} generation {generation}: ");
            let actual = lines
                .get(index + 1)
                .and_then(|s| s.strip_prefix(&prefix))
                .expect("retained turn must include its complete outcome capsule");
            assert_eq!(
                serde_json::from_str::<Value>(actual)?,
                serde_json::from_str::<Value>(&expected)?,
                "canonical outcome capsule {id}"
            );
        }
    }
    Ok(())
}
