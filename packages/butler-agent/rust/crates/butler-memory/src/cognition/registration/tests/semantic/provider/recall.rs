//! Recall over the projected windows: ranking metrics, evidence
//! hydration, vector coverage without an embedding, and paging.

use super::*;

/// A recall reader over the fixture's graph at a fixed clock.
pub(super) fn recall_reader(fixture: &Fixture) -> crate::cognition::MemoryRecall {
    let compare = Arc::new(LocaleCollation::new("en-US").unwrap());
    crate::cognition::MemoryRecall::new(
        fixture.root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(butler_core::js_date::parse_iso_millis),
        Arc::new(move |left, right| compare.compare(left, right)),
        Arc::new(|| butler_core::js_date::parse_iso_millis("2026-09-19T00:00:00.000Z").unwrap()),
        2,
    )
}

/// The exact `Straße` cue in the current session.
pub(super) fn recall_request() -> crate::cognition::RecallRequest {
    serde_json::from_value(json!({
        "cue":"Straße","seedPhrases":[],"vectorQueries":[],"includeVector":false,
        "includeInternal":false,"limit":5,"scope":"current_session",
        "projectFilter":"any","projectIds":[],"sessionIds":[],
        "asOf":"2026-09-19T00:00:00.000Z",
        "runtime":{"sessionId":"session","turnId":"turn","currentUserMessage":"find Straße",
            "nativeOperationId":"recall-native","projectId":"project"}
    }))
    .unwrap()
}

/// Graph read first, source hydration and a hashed candidate ranking in
/// between, the returned ranking last.
pub(super) fn assert_ranking_metrics(metrics: &RecallMetrics) {
    let recorded = metrics.0.lock().unwrap();
    assert!(matches!(
        recorded.first(),
        Some(crate::cognition::RecallMetric::Stage {
            name: "recall_v2_graph_read_ppr",
            ..
        })
    ));
    assert!(recorded.iter().any(|metric| matches!(
        metric,
        crate::cognition::RecallMetric::Stage {
            name: "recall_v2_source_hydration",
            ..
        }
    )));
    assert!(recorded.iter().any(|metric| matches!(metric,
    crate::cognition::RecallMetric::CandidateRanking { episode_sha256,
        native_operation_sha256, .. } if episode_sha256.len() == 64
            && native_operation_sha256.len() == 64
            && !episode_sha256.contains("episode"))));
    assert!(matches!(
        recorded.last(),
        Some(crate::cognition::RecallMetric::ReturnedRanking { .. })
    ));
}

/// The top evidence is a memory source whose message the canonical store
/// still reads.
pub(super) fn assert_evidence_hydrates(
    fixture: &Fixture,
    recall: &crate::cognition::recall::RecallResponse,
) {
    let evidence = &recall.results[0].evidence[0];
    assert!(evidence.source_ref.starts_with("memory-source:v2:"));
    assert!(evidence.excerpt.contains("Straße"));
    let canonical =
        butler_turn::conversation::ConversationSourceReader::open(&fixture.canonical_path())
            .unwrap();
    let original = canonical
        .read_message(evidence.conversation_message_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        original.message.id,
        evidence.conversation_message_id.as_deref().unwrap()
    );
    canonical.close().unwrap();
}

/// Asking for vectors without an embedding still answers from the graph and
/// reports the vector coverage as unavailable.
pub(super) async fn assert_vectors_unavailable(
    reader: &crate::cognition::MemoryRecall,
    request: &crate::cognition::RecallRequest,
) {
    let mut vector_request = request.clone();
    vector_request.include_vector = true;
    let no_embedding = reader.recall(vector_request).await.unwrap();
    assert!(!no_embedding.results.is_empty());
    assert_eq!(
        no_embedding.coverage.vectors.state,
        crate::cognition::recall::RecallCoverageState::Unavailable
    );
    assert_eq!(
        no_embedding.coverage.vectors.codes,
        ["embedding_not_configured"]
    );
}

/// One result per page: the exact cue keeps the source's raw-match priority,
/// the cursor continues in a later turn, and the specific cue retrieves the
/// corrected source. Returns the first page and the paged request as last
/// sent.
pub(super) async fn assert_pages(
    reader: &crate::cognition::MemoryRecall,
    request: &crate::cognition::RecallRequest,
) -> (
    crate::cognition::recall::RecallResponse,
    crate::cognition::RecallRequest,
) {
    let mut paged = request.clone();
    paged.limit = 1;
    paged.runtime.native_operation_id = "recall-page-one".into();
    let first_page = reader.recall(paged.clone()).await.unwrap();
    assert_eq!(first_page.results.len(), 1, "{first_page:?}");
    assert_eq!(
        first_page.results[0].evidence[0]
            .conversation_message_id
            .as_deref(),
        Some("request"),
        "the exact Straße cue retains the source's raw-match priority"
    );
    let cursor = first_page
        .next_cursor
        .clone()
        .expect("two source windows need continuation");
    paged.cursor = Some(cursor);
    paged.runtime.turn_id = "later-turn".into();
    paged.runtime.native_operation_id = "recall-page-two".into();
    let next_page = reader.recall(paged.clone()).await.unwrap();
    assert_eq!(next_page.results.len(), 1, "{next_page:?}");
    assert_eq!(
        next_page.results[0].evidence[0]
            .conversation_message_id
            .as_deref(),
        Some("request-turn2")
    );
    let mut correction_cue = request.clone();
    correction_cue.cue = "coffee".into();
    correction_cue.runtime.native_operation_id = "recall-correction".into();
    let current = reader.recall(correction_cue).await.unwrap();
    assert_eq!(
        current.results[0].evidence[0]
            .conversation_message_id
            .as_deref(),
        Some("request-turn2"),
        "the specific cue must retrieve the corrected current source"
    );
    assert_ne!(
        first_page.results[0].episode_ref,
        next_page.results[0].episode_ref
    );
    assert!(next_page.next_cursor.is_none());
    (first_page, paged)
}

/// A cursor issued before the graph revision changed is stale.
pub(super) async fn assert_cursor_goes_stale(
    reader: &crate::cognition::MemoryRecall,
    graph: &Connection,
    mut paged: crate::cognition::RecallRequest,
) {
    paged.cursor = None;
    let before_revision_change = reader.recall(paged.clone()).await.unwrap();
    paged.cursor = before_revision_change.next_cursor;
    graph
        .execute(
            "UPDATE memory_state SET value='changed-revision' WHERE key='graph_revision'",
            [],
        )
        .unwrap();
    assert_eq!(
        reader.recall(paged).await.unwrap_err().code(),
        "stale_cursor"
    );
}
