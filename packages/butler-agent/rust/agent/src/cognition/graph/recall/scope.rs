//! Source-authoritative SQL predicates for one normalized recall request.

use rusqlite::types::Value;

use crate::cognition::recall::{RecallProjectFilter, RecallRequest, RecallScope, RecallTimeBasis};

pub(super) struct Predicate {
    pub sql: String,
    pub args: Vec<Value>,
}

pub(super) fn source(input: &RecallRequest, source: &str, chunk: &str) -> Predicate {
    let conversation = if input.include_internal {
        format!(
            "{source}.source_kind='conversation' AND {source}.origin_kind IN ('user_input','assistant_public','unknown','internal_control')"
        )
    } else {
        format!(
            "{source}.source_kind='conversation' AND {source}.origin_kind IN ('user_input','assistant_public')"
        )
    };
    let typed = format!(
        "({source}.source_kind='task_report' AND {source}.role='task' AND {source}.basis='reviewed_task') \
         OR ({source}.source_kind='explicit_record' AND {source}.role='explicit' AND {source}.basis='user_statement')"
    );
    let mut clauses = vec![
        format!("{chunk}.status='active'"),
        format!("(({conversation}) OR ({typed}))"),
    ];
    let mut args = Vec::new();
    if input.scope == RecallScope::CurrentSession {
        clauses.push(format!("{chunk}.conversation_session_id=?"));
        args.push(Value::Text(input.runtime.session_id.clone()));
    }
    if input.scope == RecallScope::CurrentProject {
        clauses.push(format!("{chunk}.project_id=?"));
        args.push(
            input
                .runtime
                .project_id
                .clone()
                .map_or(Value::Null, Value::Text),
        );
    }
    if !input.session_ids.is_empty() {
        clauses.push(format!(
            "{chunk}.conversation_session_id IN ({})",
            placeholders(input.session_ids.len())
        ));
        args.extend(input.session_ids.iter().cloned().map(Value::Text));
    }
    match input.project_filter {
        RecallProjectFilter::Any => {}
        RecallProjectFilter::Unassigned => clauses.push(format!("{chunk}.project_id IS NULL")),
        RecallProjectFilter::Selected => {
            clauses.push(format!(
                "{chunk}.project_id IN ({})",
                placeholders(input.project_ids.len())
            ));
            args.extend(input.project_ids.iter().cloned().map(Value::Text));
        }
    }
    clauses.push(format!("julianday({source}.observed_at)<=julianday(?)"));
    args.push(Value::Text(input.as_of.clone()));
    if let Some(time) = input
        .time
        .as_ref()
        .filter(|time| time.basis == RecallTimeBasis::Conversation)
    {
        clauses.push(format!("julianday({source}.observed_at)>=julianday(?) AND julianday({source}.observed_at)<julianday(?)"));
        args.push(Value::Text(time.from.clone()));
        args.push(Value::Text(time.to.clone()));
    }
    Predicate {
        sql: clauses.join(" AND "),
        args,
    }
}

pub(super) fn claim(input: &RecallRequest, entity: &str, id_column: &str) -> Predicate {
    let target = format!("{entity}.{id_column}");
    let claim_types = "'preference','goal','constraint','decision','memory_atom'";
    if let Some(time) = input
        .time
        .as_ref()
        .filter(|time| time.basis == RecallTimeBasis::Event)
    {
        return Predicate {
            sql: format!(
                "({entity}.type NOT IN ({claim_types}) OR ((SELECT valid_from FROM memory_claims WHERE node_id={target}) IS NOT NULL AND julianday((SELECT valid_from FROM memory_claims WHERE node_id={target}))<julianday(?) AND julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id={target}),?))>julianday(?)))"
            ),
            args: vec![
                Value::Text(time.to.clone()),
                Value::Text(time.to.clone()),
                Value::Text(time.from.clone()),
            ],
        };
    }
    Predicate {
        sql: format!(
            "({entity}.type NOT IN ({claim_types}) OR (((SELECT valid_from FROM memory_claims WHERE node_id={target}) IS NULL OR julianday((SELECT valid_from FROM memory_claims WHERE node_id={target}))<=julianday(?)) AND ((SELECT valid_to FROM memory_claims WHERE node_id={target}) IS NULL OR julianday((SELECT valid_to FROM memory_claims WHERE node_id={target}))>julianday(?))))"
        ),
        args: vec![
            Value::Text(input.as_of.clone()),
            Value::Text(input.as_of.clone()),
        ],
    }
}

pub(super) fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

pub(super) fn event_episode(input: &RecallRequest, episode: &str) -> Predicate {
    let Some(time) = input
        .time
        .as_ref()
        .filter(|time| time.basis == RecallTimeBasis::Event)
    else {
        return Predicate {
            sql: String::new(),
            args: Vec::new(),
        };
    };
    let source = source(input, "time_source", "time_chunk");
    let mut args = vec![
        Value::Text(time.to.clone()),
        Value::Text(time.to.clone()),
        Value::Text(time.from.clone()),
    ];
    args.extend(source.args);
    Predicate{sql:format!(
        "AND EXISTS (
           SELECT 1 FROM memory_evidence time_mention
           JOIN memory_nodes time_entity ON time_entity.id=time_mention.node_id
           JOIN memory_chunk_sources time_source ON time_source.source_id=time_mention.source_id
           JOIN memory_chunks time_chunk ON time_chunk.memory_chunk_id=time_source.episode_id AND time_chunk.current_revision=time_source.revision
           WHERE time_mention.episode_id={episode}
             AND time_entity.type IN ('preference','goal','constraint','decision','memory_atom')
             AND julianday((SELECT valid_from FROM memory_claims WHERE node_id=time_entity.id))<julianday(?)
             AND julianday(COALESCE((SELECT valid_to FROM memory_claims WHERE node_id=time_entity.id),?))>julianday(?)
             AND {}
         )",source.sql),args}
}
