//! Agent context overhead measured from the real first provider request.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[path = "support/context_hot.rs"]
mod context_hot;
#[path = "support/memory_fixture.rs"]
mod memory_fixture;

fn sql<T>(result: rusqlite::Result<T>) -> Result<T, HarnessError> {
    result.map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))
}

const ASK: &str = "Reply with exactly the word: once";

fn tokens(text: &str) -> usize {
    tiktoken_rs::o200k_base_singleton()
        .encode_ordinary(text)
        .len()
}

fn matching_prefix(content: &str, prompt: &str) -> String {
    let content = content.trim();
    if content.is_empty() {
        return String::new();
    }
    let boundaries: Vec<_> = content
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(content.len()))
        .collect();
    let (mut low, mut high) = (0, boundaries.len() - 1);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if prompt.contains(&content[..boundaries[middle]]) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    if boundaries[low] < content.len().min(32) {
        String::new()
    } else {
        content[..boundaries[low]].to_owned()
    }
}

fn loaded_excerpt(id: &str, content: &str, prompt: &str) -> String {
    let needle = format!(
        "[Context excerpt elided; original {} bytes; source {id};",
        content.len()
    );
    if let Some(start) = prompt.find(&needle) {
        let head = &prompt[..start.saturating_sub(1)];
        let Some(end) = prompt[start..].find("]\n").map(|end| start + end + 2) else {
            return String::new();
        };
        let tail = &prompt[end..];
        let boundaries: Vec<_> = content
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(content.len()))
            .collect();
        let prefix = boundaries
            .iter()
            .rev()
            .copied()
            .find(|&i| head.ends_with(&content[..i]))
            .unwrap_or(0);
        let suffix = boundaries
            .iter()
            .copied()
            .find(|&i| tail.starts_with(&content[i..]))
            .unwrap_or(content.len());
        return format!(
            "{}\n{}{}",
            &content[..prefix],
            &prompt[start..end],
            &content[suffix..]
        );
    }
    matching_prefix(content, prompt)
}

fn measure(
    s: &butler_e2e::e2e::scenario::Scenario,
    request: &Value,
) -> Result<Value, HarnessError> {
    let instructions = request["instructions"].as_str().unwrap_or_default();
    let input = request["input"].to_string();
    let mut remaining = format!("{instructions}\n");
    // Decode provider input text: JSON escapes are wire overhead, not document content.
    for item in request["input"].as_array().into_iter().flatten() {
        if let Some(content) = item["content"].as_str() {
            remaining.push_str(content);
        }
        for part in item["content"].as_array().into_iter().flatten() {
            if let Some(text) = part["text"].as_str() {
                remaining.push_str(text);
            }
        }
    }
    let db = sql(Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    ))?;
    let mut sections = BTreeMap::new();
    let mut guided_prefix = instructions;
    let mut query = sql(
        db.prepare("SELECT source_id, content FROM btcc_context_documents ORDER BY source_id")
    )?;
    for row in sql(query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }))? {
        let (id, content) = sql(row)?;
        if id == "runtime-system-contract"
            && let Some(start) = instructions.find(content.trim())
        {
            guided_prefix = instructions[..start].trim_end();
        }
        let loaded = loaded_excerpt(&id, &content, &remaining);
        sections.insert(
            id,
            json!({"stored_tokens":tokens(&content),"loaded_tokens":tokens(&loaded)}),
        );
        if !loaded.is_empty() {
            remaining = remaining.replacen(&loaded, "", 1);
        }
    }
    for id in [
        "hot-cache",
        "session-continuity",
        "project-memory",
        "profile-projection",
        "rules",
        "active-persona-reminder",
    ] {
        sections
            .entry(id.into())
            .or_insert(json!({"stored_tokens":0,"loaded_tokens":0}));
    }
    Ok(
        json!({"sections":sections, "instructions":tokens(instructions),
        "tools":tokens(&request["tools"].to_string()), "input":tokens(&input),
        "serialized_request":tokens(&request.to_string()), "guided_static_prefix":tokens(guided_prefix),
        "tool_count":request["tools"].as_array().map_or(0, Vec::len)}),
    )
}

fn seed_large(data: &std::path::Path) -> Result<(), HarnessError> {
    context_hot::seed(data)?;
    std::fs::create_dir_all(data.join("personas"))?;
    std::fs::write(
        data.join("personas/active.md"),
        format!(
            "**Language:** English\n{}",
            "Keep a calm, practical voice. ".repeat(1000)
        ),
    )?;
    std::fs::write(
        data.join("eol.md"),
        "Preserve exact user intent and verify every effect.\n".repeat(600),
    )?;
    let rules = data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    let mut index = String::new();
    for i in 0..60 {
        index.push_str(&format!(
            "- [Rule {i}](rule-{i}.md)\n- [Same rule](rule-{i}.md)\n"
        ));
        std::fs::write(
            rules.join(format!("rule-{i}.md")),
            format!(
                "Rule {i}: preserve the exact project scope.\n{}",
                "Use current evidence and report the actual outcome.\n".repeat(12)
            ),
        )?;
    }
    std::fs::write(rules.join("INDEX.md"), index)?;
    Ok(())
}

async fn large_project(s: &butler_e2e::e2e::scenario::Scenario) -> Result<String, HarnessError> {
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Context scale"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let ledger = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(&project);
    std::fs::create_dir_all(&ledger)?;
    std::fs::write(ledger.join("project.json"), json!({"schema":"project-ledger.project.v1","id":project,
        "name":"Context scale","status":"active","createdAt":"2026-09-29T00:00:00Z","updatedAt":"2026-09-29T00:00:00Z"}).to_string())?;
    std::fs::write(ledger.join("ledger.jsonl"), "")?;
    let created =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":"Context scale","project_id":project}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let session = created.data()["session"].clone();
    let memory = s.sandbox.data.join("cognition/memory");
    std::fs::create_dir_all(memory.join("projects"))?;
    std::fs::write(
        memory.join("projects").join(format!("{project}.md")),
        format!(
            "Project context: garden redesign.\n{}",
            "Use the accepted garden plan and verify the current project state.\n".repeat(300)
        ),
    )?;
    std::fs::create_dir_all(memory.join("sessions"))?;
    let mut hash = format!(
        "{:x}",
        Sha256::digest(session["session_hint"].as_str().unwrap().as_bytes())
    );
    hash.truncate(32);
    std::fs::write(
        memory.join("sessions").join(format!("{hash}.md")),
        format!(
            "Session continuity: garden constraints.\n{}",
            "Historical preference: keep the existing blue iris beds.\n".repeat(300)
        ),
    )?;
    s.gw.patch("/personalization", json!({"profiling":{"mode":"basic"}}))
        .await?;
    let db = sql(Connection::open(
        s.sandbox.data.join("cognition/profile/profile.sqlite"),
    ))?;
    let hints: Vec<_> = (0..6)
        .map(|i| {
            format!(
                "Hint {i}: {}",
                "Prefer concrete garden decisions with evidence. ".repeat(8)
            )
        })
        .collect();
    let profile = json!({"version":1,"mode":"basic","updated_at":"2026-09-29T00:00:00Z","writer_kind":"manual",
        "how_to_answer":hints,"how_to_collaborate":hints,"current_attention":hints,"active_boundaries":hints,
        "likely_failure_modes":hints,"ask_before":hints});
    sql(db.execute("INSERT OR REPLACE INTO runtime_projection VALUES('active',1,'basic',?1,'2026-09-29T00:00:00Z')", [profile.to_string()]))?;
    Ok(session["id"].as_str().unwrap().into())
}

#[tokio::test]
async fn first_response_overhead_fresh_and_large_profile() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut results = BTreeMap::new();
    for (name, large) in [("fresh", false), ("large", true)] {
        let setup = Setup::new(&format!("AGENT-CONTEXT-{name}"))?
            .cassette("TURN-02")
            .replay_only();
        if large {
            seed_large(&setup.sandbox.data)?;
        }
        let s = setup.start().await?;
        let chat = if large {
            large_project(&s).await?
        } else {
            "general".into()
        };
        let (_, turn) = s.turn(&chat, ASK).await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let requests = s.provider()?.requests();
        assert_eq!(
            requests.len(),
            1,
            "first turn must use one ordinary model round"
        );
        let value = measure(&s, &requests[0])?;
        assert!(value["instructions"].as_u64().unwrap() > 0);
        assert!(value["tools"].as_u64().unwrap() > 0);
        for section in value["sections"].as_object().unwrap().values() {
            assert!(
                section["loaded_tokens"].as_u64().unwrap()
                    <= section["stored_tokens"].as_u64().unwrap() + 100,
                "section accounting may add a retrieval marker, not duplicate a document: {section}"
            );
        }
        for id in ["eol", "role", "runtime-system-contract"] {
            let section = &value["sections"][id];
            assert_eq!(section["stored_tokens"], section["loaded_tokens"], "{id}");
            assert!(section["stored_tokens"].as_u64().unwrap() > 0);
        }
        if large {
            assert!(
                value["sections"]["hot-cache"]["stored_tokens"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
        }
        let messages = s.gw.messages(&chat).await?;
        assert_eq!(
            messages.iter().filter(|m| m["role"] == "assistant").count(),
            1
        );
        assert!(
            messages
                .iter()
                .any(|m| m["role"] == "assistant"
                    && m["text"].as_str().unwrap_or_default() == "once")
        );
        results.insert(name, value);
        s.finish().await?;
    }
    eprintln!(
        "AGENT_CONTEXT_MEASUREMENTS {}",
        serde_json::to_string(&results)?
    );
    Ok(())
}
