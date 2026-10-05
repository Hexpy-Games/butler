//! Source-backed, current hot cache for the large-profile prompt measurement.
use butler_e2e::e2e::HarnessError;
use rusqlite::params;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(super) fn seed(data: &std::path::Path) -> Result<(), HarnessError> {
    let graph = super::memory_fixture::initialize_empty(data)?;
    let db = super::sql(rusqlite::Connection::open(graph))?;
    let now = "2026-09-26T00:00:00Z";
    let text = "Remember the accepted garden palette and preserve the blue iris beds.\n".repeat(80);
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let rules = data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    std::fs::write(rules.join("context-hot.md"), &text)?;
    std::fs::write(
        rules.join("context-hot.source.json"),
        json!({
        "schema":"butler.explicit-rule-binding.v1","state":"active","record_id":"context-hot",
        "revision":"revision-hot","operation_id":"operation-hot","content_hash":hash,
        "project_id":null,"conversation_session_id":null,"conversation_message_id":null,
        "observed_at":now,"operations":[]})
        .to_string(),
    )?;
    super::sql(db.execute("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at) VALUES('episode-hot','explicit_record:context-hot','revision-hot','user_input','active',?1,?2,?2)", params![hash,now]))?;
    super::sql(db.execute("INSERT INTO memory_chunk_sources VALUES('source-hot','episode-hot','revision-hot','explicit_record',NULL,NULL,'context-hot','/text',0,?1,?2,'explicit','user_input',?3,'user_statement')", params![text.len(),hash,now]))?;
    super::sql(db.execute("INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at) VALUES('job-hot','episode-hot','revision-hot','memory-extract-v3','00000000-0000-4000-8000-000000000222','stub','low','[]',?1,?1,?1,?1,?1,?2)", params!["{\"state\":\"complete\"}",now]))?;
    let entry = json!({"entry_id":"entry-hot","episode_id":"episode-hot","source_revision":"revision-hot",
        "summary":text,"source_time":now,"scope":"global","graph_revision":0,"source_refs":["source-hot"],
        "authority":"model_interpretation","source_class":"explicit","node_refs":[]});
    std::fs::create_dir_all(
        data.join("cognition/memory/generations/00000000-0000-4000-8000-000000000222/hot"),
    )?;
    std::fs::write(
        data.join("cognition/memory/generations/00000000-0000-4000-8000-000000000222/hot/cache.md"),
        format!(
            "<!-- butler-semantic:entry-hot:start -->\n<!-- butler-hot-cache-entry:v2\n{entry}\n-->\n{text}\n<!-- butler-semantic:entry-hot:end -->"
        ),
    )?;
    Ok(())
}
