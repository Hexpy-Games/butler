use super::*;
use serde_json::{Value, json};

#[test]
fn conversation_and_event_bins_match_source_bun() {
    let db = super::super::semantic::tests::fixture();
    let golden: Value =
        serde_json::from_str(include_str!("../semantic/fixtures/temporal-bun.json")).unwrap();
    for (case, from, to) in [
        ("conversation", "2026-01-01", "2026-01-08"),
        ("event", "2026-01-02", "2026-01-09"),
    ] {
        let request = json!({
            "cue":"abc","seedPhrases":[],"vectorQueries":[],"includeVector":false,
            "includeInternal":false,"limit":10,"scope":"all_user_sessions",
            "projectFilter":"any","projectIds":[],"sessionIds":[],
            "asOf":"2026-02-01T00:00:00.000Z",
            "time":{"basis":case,"from":from,"to":to},"cursor":null,
            "admittedChannels":null,
            "runtime":{"sessionId":"s1","turnId":"t","currentUserMessage":"m","nativeOperationId":"op","projectId":"p1"}
        });
        let input: RecallRequest = serde_json::from_value(request).unwrap();
        let selected = select(&db, &input, |value| match value {
            "2026-01-01" => 1_767_225_600_000.0,
            "2026-01-02" => 1_767_312_000_000.0,
            "2026-01-08" => 1_767_830_400_000.0,
            "2026-01-09" => 1_767_916_800_000.0,
            _ => f64::NAN,
        })
        .unwrap();
        assert_eq!(
            json!(selected.episode_ids),
            golden[case]["episodeIds"],
            "{case}"
        );
        assert_eq!(json!(selected.seeds), golden[case]["seeds"], "{case}");
    }
}
