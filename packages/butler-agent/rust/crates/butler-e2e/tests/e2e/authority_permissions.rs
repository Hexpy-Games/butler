//! Settings approvals use the real gateway and existing grant storage.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;
use std::time::{Duration, Instant};

mod profile;
mod scale;
mod seed;
mod source_order;
pub(super) use seed::history as seed_settled_history;
use seed::{COMMAND, command, reference, seed};

#[tokio::test]
async fn approvals_list_and_batch_revoke() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("APPROVALS-01")?.start().await?;
    seed(s.sandbox.data.clone(), 3, false).await?;
    let listed = s.gw.get("/authority-permissions").await?;
    assert_eq!(listed.status, 200);
    let grants = listed.data()["permissions"].as_array().unwrap();
    assert_eq!(grants.len(), 5);
    check_permissions(grants);
    assert_eq!(grants.iter().filter(|g| g["target"] == COMMAND).count(), 2);
    compare_original(&s, grants).await?;
    let wrong =
        s.gw.post(
            "/authority-permissions/revoke",
            json!({"grants":[{"session_id":"butler/app-chat-0","grant_ref":reference(0)},{"session_id":"butler/app-chat-2","grant_ref":reference(1)}]}),
        )
        .await?;
    assert_eq!(wrong.status, 404);
    assert_eq!(
        s.gw.get("/authority-permissions").await?.data()["permissions"]
            .as_array()
            .unwrap()
            .len(),
        5,
        "batch owner mismatch rolls back"
    );
    let input = json!({"grants":[{"session_id":"butler/app-chat-0","grant_ref":reference(0)},{"session_id":"butler/app-chat-1","grant_ref":reference(1)}]});
    let revoked =
        s.gw.post("/authority-permissions/revoke", input.clone())
            .await?;
    assert_eq!(revoked.status, 200);
    assert_eq!(
        revoked.data()["revoked"],
        json!([reference(0), reference(1)])
    );
    assert_eq!(
        s.gw.post("/authority-permissions/revoke", input)
            .await?
            .status,
        200,
        "idempotent revoke"
    );
    assert_eq!(
        s.gw.get("/authority-permissions").await?.data()["permissions"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    for (id, count) in [("chat-0", 0), ("chat-1", 1)] {
        let original =
            s.gw.get(&format!("/authority-requests?session_id={id}"))
                .await?;
        assert_eq!(
            original.data()["permissions"].as_array().unwrap().len(),
            count
        );
    }
    s.finish().await
}

#[tokio::test]
async fn approvals_owner_scale_complete_and_current() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("APPROVALS-SCALE")?
        .env("BUTLER_E2E_STORAGE_METRICS", "1")
        .start()
        .await?;
    seed(s.sandbox.data.clone(), 3_000, true).await?;
    let start = Instant::now();
    let listed = s.gw.get("/authority-permissions").await?;
    let elapsed = start.elapsed();
    let timing = listed
        .dispatch_timing
        .as_ref()
        .expect("server timing required");
    let server_us: u64 = timing.split_once(',').unwrap().1.parse().unwrap();
    eprintln!("approvals complete HTTP roundtrip={elapsed:?} server_us={server_us}");
    for line in s
        .agent
        .logs()
        .lines()
        .filter(|line| line.starts_with("approvals-profile"))
    {
        eprintln!("{line}");
    }
    assert_eq!(listed.status, 200);
    let grants = listed.data()["permissions"].as_array().unwrap();
    assert_eq!(grants.len(), 3_000);
    assert!(
        grants
            .windows(2)
            .all(|w| w[0]["created_at"].as_str() >= w[1]["created_at"].as_str())
    );
    assert_eq!(
        grants
            .iter()
            .map(|g| g["grant_ref"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3_000
    );
    let expected: std::collections::HashMap<_, _> = (0..3_000)
        .map(|i| {
            (
                reference(i),
                (
                    command(i),
                    format!("butler/app-chat-{}", i % 600),
                    format!("Chat {}", i % 600),
                ),
            )
        })
        .collect();
    for grant in grants {
        let facts = &expected[grant["grant_ref"].as_str().unwrap()];
        assert_eq!(grant["target"], facts.0);
        assert_eq!(grant["session_id"], facts.1);
        assert_eq!(grant["session_title"], facts.2);
        assert_eq!(grant["capability"], "run_command");
        assert_eq!(grant["cwd"], "/workspace");
    }
    scale::measure_current(&s, grants, server_us).await?;
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_micros(server_us),
        Duration::from_millis(50),
        "all approvals: 3000 grants / 600 owners"
    );
    s.finish().await
}

fn check_permissions(grants: &[serde_json::Value]) {
    for grant in grants {
        assert_eq!(grant["scope"], "conversation");
        assert_eq!(grant["target"] == "", grant["grant_ref"] == "orphan");
        assert!(
            grant["workspace_path"]
                .as_str()
                .unwrap()
                .starts_with("/workspace")
        );
        assert_eq!(
            grant["session_title"].is_null(),
            grant["grant_ref"] == "orphan"
        );
        assert!(grant["created_at"].is_string());
        assert!(grant.get("title").is_none());
        assert!(grant.get("description").is_none());
    }
}
async fn compare_original(
    s: &butler_e2e::e2e::scenario::Scenario,
    grants: &[serde_json::Value],
) -> Result<(), HarnessError> {
    for id in 0..3 {
        let owner = format!("butler/app-chat-{id}");
        let old =
            s.gw.get(&format!("/authority-requests?session_id=chat-{id}"))
                .await?;
        assert_eq!(old.status, 200);
        for original in old.data()["permissions"].as_array().unwrap() {
            let projected = grants
                .iter()
                .find(|g| g["session_id"] == owner && g["grant_ref"] == original["grant_ref"])
                .unwrap();
            for field in ["grant_ref", "capability", "target", "cwd"] {
                assert_eq!(projected[field], original[field]);
            }
        }
    }
    Ok(())
}
