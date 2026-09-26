use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use serde_json::{Value, json};

use super::{
    EligibleAdjacency, EpisodeRankInput, ExecutedEpisodeChannels, IdentityMembers, RecallEdge,
    RecallResultChannel, Salience, TimeBasis, diversify_by_session, expand_graph,
    fuse_episode_candidates, rank_episodes,
};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/source-bun.json")).expect("Bun golden JSON")
}

fn edge(raw: &Value) -> RecallEdge {
    RecallEdge {
        edge_id: string(raw, "edgeId"),
        source_node_id: string(raw, "sourceNodeId"),
        target_node_id: string(raw, "targetNodeId"),
        relation: string(raw, "relation"),
        claim_node_id: raw["claimNodeId"].as_str().map(str::to_owned),
        support: raw["support"].as_f64().unwrap(),
    }
}

fn string(raw: &Value, key: &str) -> String {
    raw[key].as_str().unwrap().to_owned()
}

fn strings(raw: &Value) -> Vec<String> {
    raw.as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn graph_expansion_matches_unchanged_bun_source() {
    for case in golden()["graph"].as_array().unwrap() {
        let seeds = strings(&case["seeds"]);
        let calls = RefCell::new(Vec::new());
        let now_calls = Cell::new(0usize);
        let mut identity = |node: &str, _limit: usize| -> Result<IdentityMembers, ()> {
            let record = &case["identity"][node];
            Ok(IdentityMembers {
                members: record["members"].as_array().map_or_else(Vec::new, |items| {
                    items
                        .iter()
                        .map(|item| item.as_str().unwrap().to_owned())
                        .collect()
                }),
                partial: record["partial"].as_bool().unwrap_or(false),
            })
        };
        let actual = expand_graph(
            &seeds,
            |node, limit, offset| -> Result<EligibleAdjacency, ()> {
                calls.borrow_mut().push(json!([node, limit, offset]));
                let pages = case["pages"][node].as_array();
                let index = usize::from(offset != 0);
                let edges = pages
                    .and_then(|pages| pages.get(index))
                    .and_then(Value::as_array)
                    .map_or_else(Vec::new, |items| items.iter().map(edge).collect());
                Ok(EligibleAdjacency {
                    edges,
                    truncated: offset == 0 && pages.is_some_and(|pages| pages.len() > 1),
                })
            },
            if case["deadline"] == true { 100 } else { 101 },
            || {
                let count = now_calls.get();
                now_calls.set(count + 1);
                if case["deadlineAfter"]
                    .as_u64()
                    .is_some_and(|after| count >= after as usize)
                {
                    101
                } else {
                    100
                }
            },
            Some(&mut identity),
        )
        .unwrap();
        assert_eq!(
            json!(calls.into_inner()),
            case["calls"],
            "{} calls",
            case["name"]
        );
        assert_eq!(
            json!(actual.coverage_codes),
            case["coverageCodes"],
            "{} codes",
            case["name"]
        );
        assert_eq!(
            json!(actual.edges.iter().map(|v| &v.edge_id).collect::<Vec<_>>()),
            case["edges"],
            "{} edges",
            case["name"]
        );
        let paths = actual
            .paths
            .iter()
            .map(|(node, steps)| {
                json!([
                    node,
                    steps
                        .iter()
                        .map(|step| json!({
                            "from": step.from, "relation": step.relation, "to": step.to,
                            "traversed_reverse": step.traversed_reverse,
                        }))
                        .collect::<Vec<_>>()
                ])
            })
            .collect::<Vec<_>>();
        assert_eq!(json!(paths), case["paths"], "{} paths", case["name"]);
        assert_eq!(
            actual.relevance.len(),
            case["relevance"].as_array().unwrap().len()
        );
        for (actual, expected) in actual
            .relevance
            .iter()
            .zip(case["relevance"].as_array().unwrap())
        {
            assert_eq!(expected[0].as_str().unwrap(), actual.0);
            let expected = expected[1].as_f64().unwrap();
            assert!(
                (actual.1 - expected).abs() < 1e-12,
                "{} PPR {} != {}",
                case["name"],
                actual.1,
                expected
            );
        }
    }
}

fn episode(raw: &Value) -> EpisodeRankInput {
    let rank = |key| raw[key].as_f64();
    EpisodeRankInput {
        episode_id: string(raw, "episodeId"),
        conversation_at: raw["conversationAt"].as_str().map(str::to_owned),
        event_at: raw["eventAt"].as_str().map(str::to_owned),
        session_id: raw["sessionId"].as_str().map(str::to_owned),
        graph_rank: rank("graphRank"),
        lexical_rank: rank("lexicalRank"),
        vector_rank: rank("vectorRank"),
        context_rank: rank("contextRank"),
        query_relevance: rank("queryRelevance"),
        explicit_priority: raw["explicitPriority"].as_bool(),
        salience: match raw["salience"].as_str() {
            Some("high") => Some(Salience::High),
            Some("normal") => Some(Salience::Normal),
            Some(_) => Some(Salience::Unspecified),
            None => None,
        },
        support_count: rank("supportCount"),
        half_life_days: rank("halfLifeDays"),
    }
}

fn channels(raw: &[RecallResultChannel]) -> Vec<&'static str> {
    raw.iter()
        .map(|channel| match channel {
            RecallResultChannel::Graph => "graph",
            RecallResultChannel::Vector => "vector",
            RecallResultChannel::Lexical => "lexical",
            RecallResultChannel::Context => "context",
        })
        .collect()
}

#[test]
fn episode_ranking_matches_unchanged_bun_source() {
    let golden = golden();
    let dates = golden["dates"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_f64().unwrap_or(f64::NAN)))
        .collect::<HashMap<_, _>>();
    for case in golden["ranking"].as_array().unwrap() {
        let executed = &case["executed"];
        let values = case["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(episode)
            .collect();
        let ranked = rank_episodes(
            values,
            ExecutedEpisodeChannels {
                graph: executed["graph"] == true,
                vector: executed["vector"] == true,
                lexical: executed["lexical"] == true,
                context: executed["context"] == true,
            },
            case["asOf"].as_str().unwrap(),
            if case["basis"] == "event" {
                TimeBasis::Event
            } else {
                TimeBasis::Conversation
            },
            &|value| *dates.get(value).unwrap_or(&f64::NAN),
        );
        assert_eq!(ranked.len(), case["ranked"].as_array().unwrap().len());
        for (actual, expected) in ranked.iter().zip(case["ranked"].as_array().unwrap()) {
            assert_eq!(
                actual.input.episode_id, expected["id"],
                "{} order",
                case["name"]
            );
            assert_eq!(json!(channels(&actual.channels)), expected["channels"]);
            if expected["score"] == "NaN" {
                assert!(actual.score.is_nan());
            } else {
                assert!(
                    (actual.score - expected["score"].as_f64().unwrap()).abs() < 1e-12,
                    "{} score for {}",
                    case["name"],
                    actual.input.episode_id
                );
            }
        }
        let selected = diversify_by_session(ranked, 4);
        assert_eq!(
            json!(
                selected
                    .iter()
                    .map(|value| &value.input.episode_id)
                    .collect::<Vec<_>>()
            ),
            case["diversified"],
            "{} diversity",
            case["name"]
        );
    }
}

#[test]
fn candidate_fusion_matches_unchanged_bun_source() {
    for case in golden()["fusion"].as_array().unwrap() {
        let input = &case["input"];
        let actual = fuse_episode_candidates(
            &strings(&input["graph"]),
            &strings(&input["vector"]),
            &strings(&input["lexical"]),
            &strings(&input["context"]),
        );
        assert_eq!(json!(actual.episode_ids), case["expected"]["episodeIds"]);
        assert_eq!(
            json!(actual.candidate_limit),
            case["expected"]["candidateLimit"]
        );
    }
}

#[test]
fn graph_limits_match_unchanged_bun_source() {
    let golden = golden();
    let mut identity = |node: &str, _limit: usize| -> Result<IdentityMembers, ()> {
        Ok(IdentityMembers {
            members: if node == "a" {
                (0..2000).map(|index| format!("n{index}")).collect()
            } else {
                Vec::new()
            },
            partial: false,
        })
    };
    let node = expand_graph(
        &["a".into()],
        |_, _, _| -> Result<EligibleAdjacency, ()> {
            Ok(EligibleAdjacency {
                edges: Vec::new(),
                truncated: false,
            })
        },
        101,
        || 100,
        Some(&mut identity),
    )
    .unwrap();
    assert_eq!(
        json!({"nodes": node.paths.len(), "edges": node.edges.len(),
        "codes": node.coverage_codes}),
        golden["limits"]["node"]
    );

    let edge_limit = expand_graph(
        &["a".into()],
        |node, limit, offset| -> Result<EligibleAdjacency, ()> {
            let count = if node == "a" {
                limit.min(8001 - offset)
            } else {
                0
            };
            let edges = (0..count)
                .map(|index| RecallEdge {
                    edge_id: format!("e{}", offset + index),
                    source_node_id: "a".into(),
                    target_node_id: "b".into(),
                    relation: "related_to".into(),
                    claim_node_id: None,
                    support: 1.0,
                })
                .collect();
            Ok(EligibleAdjacency {
                edges,
                truncated: node == "a" && offset + limit < 8001,
            })
        },
        101,
        || 100,
        None,
    )
    .unwrap();
    assert_eq!(
        json!({"nodes": edge_limit.paths.len(), "edges": edge_limit.edges.len(),
        "codes": edge_limit.coverage_codes}),
        golden["limits"]["edge"]
    );
}

#[test]
fn graph_callback_error_propagates_without_partial_success() {
    let result = expand_graph(
        &["a".into()],
        |_, _, _| -> Result<EligibleAdjacency, &'static str> { Err("read failed") },
        101,
        || 100,
        None,
    );
    assert_eq!(result.unwrap_err(), "read failed");
}
