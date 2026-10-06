//! Request diagnostics use admitted identities and hashes, never prompt content.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use butler_e2e::e2e::provider::Script;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn request_layout_diagnostics_are_complete_and_request_driven() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PROMPT-LAYOUT-DIAGNOSTICS")?
        .synthetic(Script {
            rounds: 1,
            path_for: Box::new(|_| "Cargo.toml".into()),
            final_text: "once".into(),
        })
        // Isolate request diagnostics from post-turn memory extraction requests.
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let (id, turn) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(turn["state"], "delivered");
    let (second, second_turn) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(second_turn["state"], "delivered");
    let requests = s.provider()?.requests();
    let path = s
        .sandbox
        .data
        .join("metrics/request-prefix-diagnostics.jsonl");
    let bytes = std::fs::read(&path)?;
    let rows: Vec<Value> = std::str::from_utf8(&bytes)
        .unwrap()
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let row = rows
        .iter()
        .find(|row| row["requestStarted"] == true && row["sessionKind"] == "parent")
        .unwrap();
    assert_eq!(row["turnId"], id);
    assert_eq!(row["trigger"], "user");
    assert_eq!(row["authRoute"], "oauth");
    assert!(row["model"].as_str().is_some());
    assert!(row["phase"].as_str().is_some());
    assert!(row["idleGapMs"].is_null());
    let sections = row["inputSections"].as_array().unwrap();
    assert_eq!(sections.last().unwrap()["id"], "current-request");
    assert!(
        sections
            .iter()
            .any(|section| section["id"] == "current-request")
    );
    let source_text = requests[0]["input"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    let mut offset = 0;
    for section in sections {
        assert!(section["bytes"].as_u64().unwrap() > 0);
        assert_eq!(section["sha256"].as_str().unwrap().len(), 64);
        assert!(section.get("content").is_none());
        if section["representation"] != "serialized_json" {
            let size = usize::try_from(section["bytes"].as_u64().unwrap()).unwrap();
            let text = &source_text[offset..offset + size];
            assert_eq!(
                section["sha256"],
                format!("{:x}", Sha256::digest(text.as_bytes()))
            );
            offset += size + 2;
        }
    }
    assert_eq!(offset.saturating_sub(2), source_text.len());
    let subsequent: Vec<_> = rows
        .iter()
        .filter(|row| row["requestStarted"] == true && row["sessionKind"] == "parent")
        .skip(1)
        .collect();
    assert!(subsequent.len() >= 2);
    assert_eq!(subsequent[0]["appendOnly"], true, "in-turn prefix changed");
    assert!(
        subsequent
            .iter()
            .all(|row| row["idleGapMs"].as_f64().unwrap() > 0.0)
    );
    assert!(subsequent.iter().any(|row| row["turnId"] == second));
    assert!(
        subsequent[0]["inputSections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|section| section["id"] == "input" && section["index"].as_u64().unwrap_or(0) > 0)
    );
    for name in ["persona", "onboarding", "reminders"] {
        assert_eq!(
            row["instructionComponents"][name].as_str().unwrap().len(),
            64
        );
    }
    assert!(!String::from_utf8_lossy(&bytes).contains("Reply with exactly"));
    let measurements: Vec<_> = rows
        .iter()
        .filter(|row| row["requestStarted"] == true && row["sessionKind"] == "parent")
        .map(|row| {
            serde_json::json!({"round":row["round"], "bytes":row["prefixBytes"],
            "prefix_percent":row["lcpPercent"], "token_prefix_percent":row["lcpTokenPercent"]})
        })
        .collect();
    eprintln!(
        "PROMPT_LAYOUT_MEASUREMENTS {}",
        serde_json::to_string(&measurements)?
    );
    let wire_bytes: Vec<_> = s
        .provider()?
        .timings()
        .iter()
        .map(|timing| timing.request_bytes)
        .collect();
    eprintln!(
        "PROMPT_LAYOUT_WIRE_BYTES {}",
        serde_json::to_string(&wire_bytes)?
    );
    let settled = std::fs::read(&path)?;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        std::fs::read(&path)? == settled,
        "idle request diagnostics writes"
    );
    s.finish().await
}
