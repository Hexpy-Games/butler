//! Format pin of the stored profile candidates, stable entries, runtime
//! projection, extractor prompts and third-party import manifests.
//!
//! The golden in `format-pin.json` was generated from the pre-typing
//! `serde_json::Value` profile code. Run with `BUTLER_BLESS_FORMAT=1` to
//! regenerate it only when a format change is intended.

use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};

use rusqlite::types::Value as SqlValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::understanding::{Confidence, Expiry, SourceType};
use super::support::{Root, service_with_parts};
use super::*;
use butler_models::models::{
    ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ProviderPromptResult,
};

struct Scripted {
    prompts: Arc<Mutex<Vec<String>>>,
}

impl ProviderPromptPort for Scripted {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        let prompt = request.prompt.to_owned();
        self.prompts.lock().unwrap().push(prompt.clone());
        let text = respond(&prompt);
        Box::pin(async move {
            Ok(ProviderPromptResult {
                text,
                model: "openai/test".into(),
                usage: None,
            })
        })
    }
}

fn respond(prompt: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(prompt) else {
        return format!(
            "Here you go: {}",
            json!({"candidates":[
                {"category":"aesthetics","facet":"quality_sense","summary":"Values polished   UI",
                 "source_type":"explicit","confidence":"medium","evidence_refs":["ignored"]},
                {"category":"identity","facet":"roles","summary":"Leads a small studio",
                 "source_type":"inference","confidence":"low","sensitive_domain":true,
                 "layer":"narrative_meaning","temporal_scope":"durable"}
            ]})
        );
    };
    let reference = parsed["observations"][0]["ref"].clone();
    let targets = parsed["correction_targets"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let candidates = if let Some(target) = targets
        .iter()
        .find(|target| target["category"] == "communication")
    {
        json!([
            {"category":"communication","facet":"tone_preference",
             "summary":"Detailed answers when explanations are requested",
             "applies_when":["answering"],"source_type":"explicit","confidence":"high",
             "evidence_refs":[reference],"contradiction_refs":[target["target_ref"]]},
            {"category":"cares","facet":"current_interests","summary":"Rust migration of Butler",
             "butler_should":["Mention Rust tradeoffs","  Mention   Rust tradeoffs "],
             "source_type":"repeated_observation","confidence":"high","evidence_refs":[reference]},
            {"category":"boundaries","facet":"privacy_rules","summary":"Do not share private notes",
             "source_type":"repeated_observation","confidence":"medium","evidence_refs":[reference]}
        ])
    } else {
        json!([
            {"category":"communication","facet":"tone_preference","summary":"Prefers  concise answers",
             "layer":"contextual_adaptation","applies_when":["answering"," answering "],
             "butler_should":["Keep answers short"],"source_type":"explicit","confidence":"high",
             "evidence_refs":[reference],"sensitive_domain":false,"expires_or_decay":"decay"},
            {"category":"cares","facet":"current_interests","summary":"Rust migration of Butler",
             "source_type":"explicit","confidence":"medium","evidence_refs":[reference],
             "sensitive_domain":true,"sensitivity":"restricted","temporal_scope":"active",
             "decay_policy":"days_30"},
            {"category":"values","facet":"explicit_values","summary":"Values careful verification",
             "source_type":"inference","confidence":"low","evidence_refs":[reference],
             "sensitive_domain":true,"sensitivity":"sensitive","layer":"bogus",
             "expires_or_decay":"expires"},
            {"category":"boundaries","facet":"privacy_rules","summary":"Do not share private notes",
             "source_type":"repeated_observation","confidence":"medium","evidence_refs":[reference],
             "butler_should_not":["share notes"],"contradiction_refs":[]}
        ])
    };
    json!({ "candidates": candidates }).to_string()
}

fn message(id: &str, created_at: &str, text: &str) -> CanonicalProfileMessage {
    CanonicalProfileMessage {
        id: id.into(),
        session_id: "s1".into(),
        role: "user".into(),
        origin_kind: "user_input".into(),
        created_at: created_at.into(),
        parts: vec![CanonicalProfilePart {
            part_id: format!("{id}-part"),
            part_index: 0.0,
            scalars: vec![CanonicalProfileScalar {
                pointer: "/text".into(),
                source_hash: format!("{:x}", Sha256::digest(text.as_bytes())),
                text: text.into(),
            }],
        }],
    }
}

fn stable_id(category: &str, facet: &str, summary: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(category);
    hash.update([0]);
    hash.update(facet);
    hash.update([0]);
    hash.update(summary);
    format!("sp_{}", &format!("{:x}", hash.finalize())[..16])
}

fn table(db: &rusqlite::Connection, sql: &str) -> Value {
    let mut statement = db.prepare(sql).unwrap();
    let names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let rows = statement
        .query_map([], |row| {
            let mut object = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get::<_, SqlValue>(index)? {
                    SqlValue::Null => Value::Null,
                    SqlValue::Integer(value) => json!(value),
                    SqlValue::Real(value) => json!(value),
                    SqlValue::Text(value) => json!(value),
                    SqlValue::Blob(value) => json!(value),
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    Value::Array(rows)
}

fn snapshot(root: &Root) -> Value {
    let db = storage::open(&root.0, false).unwrap();
    json!({
        "candidates": table(&db, "SELECT * FROM profile_candidates ORDER BY id"),
        "stable": table(&db, "SELECT * FROM stable_profile_entries ORDER BY id"),
        "projection": table(&db, "SELECT * FROM runtime_projection ORDER BY id"),
    })
}

fn seed_legacy_rows(root: &Root) {
    let db = storage::open(&root.0, true).unwrap();
    db.execute(
        "INSERT INTO profile_candidates(id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at) VALUES('pc_legacy','communication',?1,'user_confirmed','odd',1,'2023-11-01T00:00:00.000Z','2023-11-02T00:00:00.000Z','2023-11-03T00:00:00.000Z','never','candidate',NULL)",
        [r#"{"summary":"  Explain   tradeoffs ","facet":"not_a_facet","layer":"bogus","applies_when":["x",1," x "],"butler_should":[],"evidence_refs":["legacy:a","legacy:a",""],"evidence_count":2.5,"evidence_observed_at":{"legacy:a":"2023-11-01T00:00:00+02:00","legacy:b":7," ":null},"extra":{"k":1}}"#],
    )
    .unwrap();
    db.execute(
        "INSERT INTO stable_profile_entries(id,category,payload_json,confidence,source_type,created_at,updated_at) VALUES(?1,'communication',?2,'high','explicit','2020-01-01T00:00:00.000Z','2020-01-02T00:00:00.000Z')",
        [
            stable_id("communication", "", "Explain tradeoffs"),
            r#"{"evidence_refs":["old:1",5],"applies_when":["legacy"],"butler_should":["Keep it"],"contradiction_refs":[],"evidence_observed_at":{"old:1":123,"legacy:a":"x"},"evidence_count":7,"sensitivity":"restricted"}"#.into(),
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO profile_candidates(id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at) VALUES(?1,'agency',?2,'explicit','medium',0,'2023-10-01T00:00:00.000Z','2023-10-02T00:00:00.000Z','2023-12-03T00:00:00.000Z','expires','weird','p')",
        [
            stable_id("agency", "goals", "Ship the Rust port").replacen("sp_", "pc_", 1),
            r#"{"summary":"Ship the Rust port","facet":"goals","layer":"narrative_meaning","temporal_scope":"bogus","applies_when":["release"," release "],"butler_should":["Track milestones",3],"evidence_refs":["legacy:x"],"evidence_count":4,"evidence_observed_at":{"legacy:x":"not a date"},"contradiction_refs":["sp_zzz"]}"#.into(),
        ],
    )
    .unwrap();
}

#[tokio::test]
async fn stored_profile_rows_prompts_and_manifests_keep_their_bytes() {
    let root = Root::new("format-pin");
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let messages = Arc::new(Mutex::new(HashMap::from([(
        "m1".into(),
        message(
            "m1",
            "2023-11-14T20:00:00.000Z",
            "I prefer concise answers. I am migrating Butler to Rust.",
        ),
    )])));
    let (service, _) = service_with_parts(
        &root,
        messages.clone(),
        Arc::new(Scripted {
            prompts: prompts.clone(),
        }),
    );
    service
        .set_profiling_mode(ProfilingMode::Deep)
        .await
        .unwrap();
    service
        .capture_profile_candidates_from_transcripts_with_model(Default::default())
        .await
        .unwrap();
    let captured = snapshot(&root);
    service.consolidate_profile_candidates().await.unwrap();
    let first_consolidation = snapshot(&root);

    messages.lock().unwrap().insert(
        "m2".into(),
        message(
            "m2",
            "2023-11-14T21:00:00.000Z",
            "Actually, give detailed answers when I ask for explanations.",
        ),
    );
    service
        .capture_profile_candidates_from_transcripts_with_model(Default::default())
        .await
        .unwrap();
    service.consolidate_profile_candidates().await.unwrap();
    let second_consolidation = snapshot(&root);

    let stale = candidates::upsert(
        &root.0,
        &ProfileCandidateInput {
            category: "affective_landscape".into(),
            draft: draft(
                json!({"summary":"Gets  frustrated by vague status","facet":"frustrations"}),
            ),
            source_type: SourceType::Inference,
            confidence: Confidence::Low,
            sensitive_domain: false,
            evidence_ref: Some(" legacy:1 ".into()),
            evidence_observed_at: Some("2023-01-01T00:00:00Z".into()),
            expires_or_decay: Some(Expiry::Decay),
        },
        "2023-01-01T00:00:00.000Z",
    )
    .unwrap()
    .unwrap();
    let confirmed = candidates::upsert(
        &root.0,
        &ProfileCandidateInput {
            category: "relationships".into(),
            draft: draft(json!({"summary":"Works with a design partner","facet":null,
                "layer":"stable_disposition","applies_when":["planning"],
                "butler_should":["Mention partner reviews"],"butler_should_not":[],
                "contradiction_refs":[],"temporal_scope":"durable",
                "decay_policy":"never_without_consent","sensitivity":"sensitive"})),
            source_type: SourceType::UserConfirmed,
            confidence: Confidence::Medium,
            sensitive_domain: true,
            evidence_ref: None,
            evidence_observed_at: None,
            expires_or_decay: None,
        },
        "2023-11-14T22:13:20.000Z",
    )
    .unwrap()
    .unwrap();
    seed_legacy_rows(&root);
    let merged = candidates::upsert(
        &root.0,
        &ProfileCandidateInput {
            category: "agency".into(),
            draft: draft(
                json!({"summary":"Ship the  Rust port","facet":"goals","layer":null,
                "applies_when":["shipping"],"butler_should":[],"butler_should_not":["Nag"],
                "contradiction_refs":[],"temporal_scope":null,"decay_policy":"days_7",
                "sensitivity":"normal"}),
            ),
            source_type: SourceType::Inference,
            confidence: Confidence::High,
            sensitive_domain: false,
            evidence_ref: Some("legacy:y".into()),
            evidence_observed_at: Some("bad time".into()),
            expires_or_decay: None,
        },
        "2023-11-14T22:13:20.000Z",
    )
    .unwrap()
    .unwrap();
    service.consolidate_profile_candidates().await.unwrap();
    let third_consolidation = snapshot(&root);

    service
        .import_profile_candidates_from_third_party_dump_with_model(
            ProfileThirdPartyImportOptions {
                text: "  durable preference\r\nfrom export  ".into(),
                source: Some(" Other Assistant! ".into()),
                model: None,
                now_epoch_millis: Some(1_700_000_000_000.0),
                cancellation: Default::default(),
            },
        )
        .await
        .unwrap();
    let imported = snapshot(&root);
    let manifests = fs::read_dir(root.0.join("personalization/profile-imports"))
        .unwrap()
        .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>();
    let reflective = service.reflective_summary("en").await.unwrap();
    let projection = service.read_runtime_profile_projection().await.unwrap();
    service.close().await;

    let pinned = json!({
        "captured": captured,
        "first_consolidation": first_consolidation,
        "second_consolidation": second_consolidation,
        "stale_record": serde_json::to_string(&stale).unwrap(),
        "confirmed_record": serde_json::to_string(&confirmed).unwrap(),
        "merged_record": serde_json::to_string(&merged).unwrap(),
        "third_consolidation": third_consolidation,
        "imported": imported,
        "manifests": manifests,
        "prompts": *prompts.lock().unwrap(),
        "reflective": reflective,
        "projection": projection,
    });
    let text = butler_core::json::pretty(&pinned);
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/profile/tests/format-pin.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "profile format changed");
}
