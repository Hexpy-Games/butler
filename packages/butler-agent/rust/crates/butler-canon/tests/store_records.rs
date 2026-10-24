#![allow(clippy::unwrap_used, reason = "test assertions")]
#[path = "support/attachments.rs"]
mod attachments;
mod store_support;
use butler_canon::{store::*, work_ids::*, work_types::*};
use serde_json::json;
use store_support::*;
// test-category: pure-logic
#[test]
fn plan_work_spec_cas_and_immutable_publication() {
    let mut db = db();
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    let mut fields = PlanFields {
        title: "plan".into(),
        description: "description".into(),
        due_on: Some("2026-10-22".into()),
        status: PlanStatus::Open,
    };
    create_plan(
        &tx,
        &context(),
        "pl",
        "project",
        &fields,
        &Registration::Canon(UserAct::new("tester")),
    )
    .unwrap();
    fields.status = PlanStatus::Closed;
    edit_plan(&tx, &context(), "pl", 0, &fields).unwrap();
    assert!(
        matches!(edit_plan(&tx,&context(),"pl",0,&fields),Err(Error::Conflict{current}) if current["revision"]==1)
    );
    fields.status = PlanStatus::Open;
    assert_eq!(
        edit_plan(&tx, &context(), "pl", 1, &fields).unwrap()["status"],
        "open"
    );
    let node = NewSpecNode {
        id: "sp".into(),
        scope_kind: ScopeKind::Project,
        scope_ref: "project".into(),
        epic_id: None,
        parent_node_id: None,
        concern_id: "concern".into(),
    };
    create_spec_node(
        &tx,
        &context(),
        &node,
        &Registration::Canon(UserAct::new("tester")),
    )
    .unwrap();
    let hash = put_body(&tx, "# Body\n").unwrap();
    assert_eq!(hash, put_body(&tx, "# Body\n").unwrap());
    let publication = Publication {
        revision: 1,
        body_hash: hash.clone(),
        parser_version: "structured-1".into(),
        criteria: vec![Criterion {
            id: "c".into(),
            part_id: "p".into(),
            text: "criterion".into(),
        }],
    };
    publish_spec(&tx, &context(), "sp", 0, &publication).unwrap();
    assert!(matches!(
        activate_spec(&tx, &context(), "sp", 0, None, 1),
        Err(Error::Conflict { .. })
    ));
    activate_spec(&tx, &context(), "sp", 1, None, 1).unwrap();
    assert!(
        matches!(activate_spec(&tx,&context(),"sp",2,Some(99),1),Err(Error::Conflict {current}) if current["active_revision"]==1)
    );
    let mut second = publication.clone();
    second.revision = 2;
    second.body_hash = put_body(&tx, "second body").unwrap();
    publish_spec(&tx, &context(), "sp", 2, &second).unwrap();
    assert_eq!(
        activate_spec(&tx, &context(), "sp", 3, Some(1), 2).unwrap()["active_revision"],
        2
    );
    assert_eq!(
        tx.query_row::<String, _, _>(
            "SELECT state FROM canon_spec_revisions WHERE node_id='sp' AND revision=1",
            [],
            |r| r.get(0)
        )
        .unwrap(),
        "inactive"
    );
    let compressed: Vec<u8> = tx
        .query_row(
            "SELECT body FROM canon_spec_bodies WHERE hash=?1",
            [hash],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        zstd::stream::decode_all(compressed.as_slice()).unwrap(),
        b"# Body\n"
    );
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn session_bindings_and_rank_have_typed_rules() {
    let mut db = db();
    work(&mut db, "a");
    work(&mut db, "b");
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    bind_session(&tx, &context(), "a", "home").unwrap();
    bind_session(&tx, &context(), "b", "home").unwrap();
    bind_session(&tx, &context(), "a", "aaa").unwrap();
    bind_session(&tx, &context(), "a", "home").unwrap();
    let epic = api::epic(&tx, "a").unwrap();
    assert_eq!(epic["home_session_id"], "home");
    assert_eq!(epic["session_ids"], json!(["home", "aaa"]));
    assert!(
        epic["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("bound_by").is_none())
    );
    assert!(matches!(
        set_plan_rank(&tx, &context(), "a", 0, None, Some("A"), Some("A")),
        Err(Error::InvalidRank)
    ));
    set_plan_rank(&tx, &context(), "a", 0, None, None, None).unwrap();
    assert!(matches!(
        edit_work(
            &tx,
            &context(),
            "a",
            0,
            &WorkFields::from_snapshot(&read_work(&tx, "a").unwrap()).unwrap()
        ),
        Err(Error::Conflict { .. })
    ));
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn intent_replay_skips_domain_change_and_preserves_original_payload() {
    let mut db = db();
    let tx = Transaction::new(db.transaction().unwrap()).unwrap();
    let first = with_intent(
        &tx,
        &context(),
        "op-2",
        "create_chat",
        &json!({"chat":"a"}),
        |_| Ok(()),
    )
    .unwrap();
    let replay = with_intent(&tx, &context(), "op-2", "different", &json!({}), |_| {
        panic!("replayed domain mutation")
    })
    .unwrap();
    assert_eq!(first, replay);
    record_intent(&tx, &context(), "op-1", "create_chat", &json!({})).unwrap();
    assert_eq!(pending_intents(&tx, "", 10).unwrap()[0]["op_id"], "op-1");
    mark_intent_applied(&tx, &context(), "op-1", 0).unwrap();
    assert!(matches!(
        mark_intent_applied(&tx, &context(), "op-1", 0),
        Err(Error::Conflict { .. })
    ));
    assert_eq!(pending_intents(&tx, "", 10).unwrap().len(), 1);
    tx.commit().unwrap();
}
// test-category: pure-logic
#[test]
fn identifiers_pin_crockford_format_and_monotonic_clock_regression() {
    assert_eq!(
        encode(IdKind::Work, 0, [0; 10]).unwrap(),
        "wk_00000000000000000000000000"
    );
    assert_eq!(
        encode(IdKind::Plan, 0xffff_ffff_ffff, [255; 10]).unwrap(),
        "pl_7ZZZZZZZZZZZZZZZZZZZZZZZZZ"
    );
    assert!(encode(IdKind::Task, 1 << 48, [0; 10]).is_err());
    let mut generator = IdGenerator::default();
    let mut previous = String::new();
    for now in [100, 100, 99, 101, 101] {
        let id = generator.next(IdKind::Spec, now, [9; 10]).unwrap();
        assert!(id > previous);
        assert_eq!(id.len(), 29);
        previous = id;
    }
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut nibbles = std::collections::BTreeSet::new();
    for i in 0..512 {
        let id = IdGenerator::global_next(IdKind::Work, 1_000_000 + i).unwrap();
        let bits = id[3..].bytes().fold(0u128, |v, c| {
            (v << 5) | alphabet.iter().position(|x| *x == c).unwrap() as u128
        });
        nibbles.insert((bits >> 76) & 15);
    }
    assert_eq!(nibbles.len(), 16);
}
// test-category: format-pin
#[test]
fn every_store_statement_has_an_indexed_query_plan() {
    let db = db();
    for (name, sql) in sql::ALL.iter().chain(butler_canon::store::api::sql::ALL) {
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let n = stmt.parameter_count();
        let plan = stmt
            .query_map(
                rusqlite::params_from_iter(std::iter::repeat_n(rusqlite::types::Value::Null, n)),
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n");
        let index = match *name {
            "TAGS" => Some("sqlite_autoindex_canon_tags_2"),
            "EPIC_TAGS" => Some("sqlite_autoindex_canon_epic_tags_1"),
            "TAG_EPICS" => Some("canon_epic_tags_tag"),
            _ => None,
        };
        if let Some(index) = index {
            assert!(plan.contains(index), "{name}: {plan}");
        }
        assert!(
            !plan.contains("SCAN canon_")
                && !plan.contains("SCAN a")
                && !plan.contains("SCAN t")
                && !plan.contains("SCAN e"),
            "{name}: {plan}"
        );
    }
}

// test-category: pure-logic
#[test]
fn epic_creation_records_fields_without_a_synthetic_edit() {
    attachments::markdown_references_match_rendered_links_and_images();
    attachments::attachment_limit_counts_unique_references_and_rejects_invalid_ids();
    for tagged in [false, true] {
        for planned in [false, true] {
            let mut db = store_support::db();
            let tx = Transaction::new(db.transaction().unwrap()).unwrap();
            let tag = write_api(
                &tx,
                &context(),
                api::Resource::CreateTag,
                "project",
                json!({"name":"Feature","color":"blue"}),
            )
            .unwrap();
            let plan = write_api(
                &tx,
                &context(),
                api::Resource::CreatePlan,
                "project",
                json!({"title":"Plan"}),
            )
            .unwrap();
            let description =
                "Description ![](attachment:file-00000000-0000-0000-0000-000000000001)";
            let mut input = json!({"title":"Title","description":description,"assignee":"person"});
            if tagged {
                input["tags"] = json!([tag["id"]]);
            }
            if planned {
                input["plan_id"] = plan["id"].clone();
            }
            let epic =
                write_api(&tx, &context(), api::Resource::CreateEpic, "project", input).unwrap();
            assert_eq!(epic["description"], description);
            assert_eq!(epic["assignee"], "person");
            assert_eq!(epic["revision"], 1);
            assert_eq!(epic["tags"].as_array().unwrap().len(), usize::from(tagged));
            let mut stmt = tx
                .prepare("SELECT payload_json FROM canon_audit ORDER BY seq")
                .unwrap();
            let audits = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .skip(2) // Tag and plan setup records.
                .map(|r| serde_json::from_str::<serde_json::Value>(&r.unwrap()).unwrap())
                .collect::<Vec<_>>();
            let mut expected = vec![
                json!(["work", epic["id"], 0, "create"]),
                json!(["work", epic["id"], 1, "reorder"]),
                json!(["backlog", "project", 1, "order"]),
            ];
            if planned {
                expected.push(json!(["plan", plan["id"], 1, "order"]));
            }
            assert_eq!(
                audits
                    .iter()
                    .map(|a| json!([a["entity_kind"], a["entity_id"], a["revision"], a["op"]]))
                    .collect::<Vec<_>>(),
                expected
            );
            let mut stmt = tx.prepare("SELECT payload_json FROM canon_events WHERE topic='canon.changed' ORDER BY seq").unwrap();
            let events = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .skip(2) // Tag and plan setup records.
                .map(|r| serde_json::from_str::<serde_json::Value>(&r.unwrap()).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                events
                    .iter()
                    .map(|e| json!([e["kind"], e["id"], e["revision"]]))
                    .collect::<Vec<_>>(),
                expected
                    .iter()
                    .map(|e| json!([e[0], e[1], e[2]]))
                    .collect::<Vec<_>>()
            );
            for payload in events.iter().filter(|event| event["kind"] == "work") {
                assert_eq!(
                    payload["attachments"],
                    json!(["file-00000000-0000-0000-0000-000000000001"])
                );
            }
            for payload in [&audits[0], &events[0]] {
                if tagged {
                    assert_eq!(payload["tags"], epic["tags"]);
                } else {
                    assert!(payload.get("tags").is_none());
                }
            }
            assert!(
                audits[1..]
                    .iter()
                    .chain(&events[1..])
                    .all(|p| p.get("tags").is_none())
            );
            assert_eq!(
                read_plan(&tx, plan["id"].as_str().unwrap()).unwrap()["revision"],
                i64::from(planned)
            );
        }
    }
}
