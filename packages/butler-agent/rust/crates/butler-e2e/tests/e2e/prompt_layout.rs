//! Request diagnostics hash only fixed system-authored sections, never user content.
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
    assert_eq!(row["authRoute"], "chatgpt_plan");
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
        let system_authored = matches!(
            section["id"].as_str().unwrap(),
            "tools"
                | "history-heading"
                | "current-turn-heading"
                | "delegated-tools"
                | "runtime-state"
                | "role"
                | "chats-reply-rules"
                | "runtime-system-contract"
        );
        if system_authored {
            assert_eq!(section["sha256"].as_str().unwrap().len(), 64);
        } else {
            assert!(section.get("sha256").is_none());
        }
        assert!(section.get("content").is_none());
        if section["representation"] != "serialized_json" {
            let size = usize::try_from(section["bytes"].as_u64().unwrap()).unwrap();
            let text = &source_text[offset..offset + size];
            if system_authored {
                assert_eq!(
                    section["sha256"],
                    format!("{:x}", Sha256::digest(text.as_bytes()))
                );
            }
            offset += size + 2;
        }
    }
    assert_eq!(offset.saturating_sub(2), source_text.len());
    for row in &rows {
        if row["requestStarted"] != true {
            continue;
        }
        for section in row["inputSections"].as_array().unwrap() {
            let system_authored = matches!(
                section["id"].as_str().unwrap(),
                "tools"
                    | "history-heading"
                    | "current-turn-heading"
                    | "delegated-tools"
                    | "runtime-state"
                    | "role"
                    | "chats-reply-rules"
                    | "runtime-system-contract"
            );
            if !system_authored {
                assert!(section.get("sha256").is_none());
            }
        }
        for component in ["persona", "reminders"] {
            assert!(
                row["instructionComponents"][component]
                    .get("sha256")
                    .is_none()
            );
        }
    }
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
    let persona = &row["instructionComponents"]["persona"];
    assert!(persona["bytes"].as_u64().is_some());
    assert!(persona.get("sha256").is_none());
    let reminders = &row["instructionComponents"]["reminders"];
    assert!(reminders["bytes"].as_u64().is_some());
    assert!(reminders.get("sha256").is_none());
    assert_eq!(
        row["instructionComponents"]["onboarding"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
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

#[tokio::test]
async fn prompt_uses_local_timezone_and_rfc3339_offset() -> Result<(), HarnessError> {
    use serde_json::json;
    butler_e2e::gate!();
    let host = butler_platform::instance::system_time_zone_name()?;
    let s = Setup::new("PROMPT-LOCAL-TIME")?
        .env("TZ", "Pacific/Honolulu")
        .synthetic(Script {
            rounds: 1,
            path_for: Box::new(|_| "Cargo.toml".into()),
            final_text: "once".into(),
        })
        .start()
        .await?;
    let settings = s.gw.get("/settings").await?;
    assert_eq!(settings.data()["timezone"], "UTC");
    let config: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(config["user"]["timezone"], "UTC");
    s.turn("general", "Reply in the pinned timezone").await?;
    // Bootstrap calls can precede the parent turn; inspect its runtime state.
    let pinned = parent_prompt(&s.provider()?.requests())?;
    assert!(pinned.contains("User Timezone: UTC"));
    s.gw.patch("/settings", json!({"timezone":host})).await?;
    s.turn("general", "Reply once").await?;
    let first = parent_prompt(&s.provider()?.requests())?;
    assert!(
        first.contains(&format!("User Timezone: {host}")),
        "host timezone missing"
    );
    s.gw.patch("/settings", json!({"timezone":"Pacific/Kiritimati"}))
        .await?;
    s.turn("general", "Reply once again").await?;
    let requests = s.provider()?.requests();
    let local = requests
        .iter()
        .map(Value::to_string)
        .find(|request| request.contains("User Timezone: Pacific/Kiritimati"))
        .unwrap();
    assert!(local.contains("+14:00"));
    assert!(local.contains("Current Local Timestamp:"));
    let text = requests
        .iter()
        .filter_map(|request| request["input"][0]["content"][0]["text"].as_str())
        .find(|text| text.contains("User Timezone: Pacific/Kiritimati"))
        .unwrap();
    let timestamp = |prefix: &str| {
        chrono::DateTime::parse_from_rfc3339(
            text.lines()
                .find_map(|line| line.strip_prefix(prefix))
                .unwrap(),
        )
        .unwrap()
    };
    let local_time = timestamp("Current Local Timestamp: ");
    let utc_time = timestamp("Current Time UTC: ");
    assert_eq!(local_time.offset().local_minus_utc(), 14 * 3600);
    assert_eq!(local_time.timestamp(), utc_time.timestamp());
    assert_eq!(
        local_time.date_naive(),
        utc_time.with_timezone(local_time.offset()).date_naive()
    );

    s.finish().await
}

fn parent_prompt(requests: &[Value]) -> Result<String, HarnessError> {
    requests
        .iter()
        .rev()
        .filter_map(|request| request["input"][0]["content"][0]["text"].as_str())
        .find(|text| text.contains("Session ID: butler/app-general"))
        .map(str::to_owned)
        .ok_or_else(|| std::io::Error::other("parent turn runtime state missing").into())
}
