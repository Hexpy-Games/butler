//! On-demand, non-gating proactive-answer metrics.
use std::io::Write;

use super::{HarnessError, Scenario, answer, live_turn, start, tool_rows, turn_state};
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "LIVE tier"]
async fn live_11_proactive_answers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Some((s, _)) = start("LIVE-11").await? else {
        return Ok(());
    };
    fixtures(&s)?;
    let mut cases = vec![
        (
            "H1",
            "en",
            "Which version does this project declare, and when was its last release?",
        ),
        (
            "H2",
            "ko",
            "notes 폴더 회의록 정리해서 다음에 할 일 뽑아줘.",
        ),
        (
            "H3",
            "en",
            "Compare the approaches in a.txt and b.txt and tell me which one to use.",
        ),
        ("H4", "ko", "notes 폴더에서 가장 최근 회의가 언제였어?"),
        (
            "H5",
            "en",
            "Draft a short email to my landlord about the broken heater.",
        ),
        ("H6", "en", "What did I have for lunch yesterday?"),
    ];
    if std::env::var("BUTLER_E2E_HEDGE_WEB").as_deref() == Ok("1") {
        cases.extend([
            ("H7", "ko", "Rust 최신 안정 버전과 출시일 알려줘."),
            (
                "H8",
                "en",
                "What is the current Node.js LTS version and when does its support end?",
            ),
        ]);
    }
    let mut hit_cases = 0;
    for (case, lang, prompt) in &cases {
        let chat = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
        let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
        let (id, turn) = live_turn(&s, &chat, prompt).await?;
        assert_eq!(turn_state(&turn), "delivered", "{case}: {turn}");
        let text = answer(&s, &chat, &id).await?;
        let lint = butler_e2e::e2e::hedge::hits(&text);
        hit_cases += usize::from(!lint.is_empty());
        let tools = tools(&s, &chat, &id).await?;
        eprintln!(
            "HEDGE_LINT case={case} hits={} {}",
            lint.len(),
            lint.join(",")
        );
        if let Some(path) = std::env::var_os("BUTLER_E2E_HEDGE_OUT") {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?;
            writeln!(
                file,
                "{}",
                json!({"case":case,"lang":lang,"prompt":prompt,
                "answer":text,"lint":lint,"tools":tools})
            )?;
        }
    }
    eprintln!("HEDGE_LINT_RATE {hit_cases}/{}", cases.len());
    s.finish().await
}

fn fixtures(s: &Scenario) -> Result<(), HarnessError> {
    let workspace = &s.sandbox.data;
    std::fs::create_dir_all(workspace.join("notes"))?;
    for (name, text) in [
        (
            "Cargo.toml",
            include_str!("../../../fixtures/live-hedge/Cargo.toml.fixture"),
        ),
        (
            "CHANGELOG.md",
            include_str!("../../../fixtures/live-hedge/CHANGELOG.md"),
        ),
        ("a.txt", include_str!("../../../fixtures/live-hedge/a.txt")),
        ("b.txt", include_str!("../../../fixtures/live-hedge/b.txt")),
        (
            "notes/2026-09-30.md",
            include_str!("../../../fixtures/live-hedge/notes/2026-09-30.md"),
        ),
        (
            "notes/2026-10-07.md",
            include_str!("../../../fixtures/live-hedge/notes/2026-10-07.md"),
        ),
    ] {
        std::fs::write(workspace.join(name), text)?;
    }
    Ok(())
}

async fn tools(s: &Scenario, chat: &str, id: &str) -> Result<Vec<Value>, HarnessError> {
    let mut tools = Vec::new();
    for row in tool_rows(&s.gw.messages(chat).await?, id) {
        let output = s.gw.operation_output(id, &row).await?;
        tools.push(
            json!({"name":row["safe_tool_name"],"ok":row["state"] == "delivered",
            "output":output.chars().take(2_000).collect::<String>()}),
        );
    }
    Ok(tools)
}
