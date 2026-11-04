//! Synthetic pages through the production runtime, with no network/model calls.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, sandbox::Sandbox};
use butler_runtime::web_access::{LivePage, testing};
use serde_json::json;
use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn focused_reading_orders_retains_and_continues_exact_passages() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("FOCUSED-READING")?;
    let access = testing::access(sandbox.data.clone(), "https://93.184.216.34/");
    let session = access.session_for_turn(String::new());
    use std::fmt::Write;
    let mut body = String::new();
    for i in 0..60 {
        write!(
            body,
            "<p>Measurement {i} is λ{i}. The context explains observation {i} completely.</p>"
        )
        .unwrap();
    }
    let html = format!(
        "<nav>Navigation</nav><aside>Advertisement</aside><main><h1>Measurements</h1>{body}</main><footer>Final measurement is 91.</footer>"
    );
    let live = || LivePage {
        tab: "page".into(),
        epoch: 1,
        final_url: "https://93.184.216.34/".into(),
        html: html.clone(),
    };
    let cancellation = CancellationToken::new();
    let first = session
        .web_read_from(&json!({"tab":"page"}), Some(live()), true, &cancellation)
        .await
        .unwrap();
    let initial = first["markdown"].as_str().unwrap();
    let fact = initial.find("Measurement 0").expect("main fact is present");
    for chrome in ["Navigation", "Advertisement", "Final measurement"] {
        if let Some(position) = initial.find(chrome) {
            assert!(fact < position, "{initial}");
        }
    }
    let mut seen = BTreeSet::new();
    let mut cursor = 0;
    let mut reached_footer = false;
    loop {
        let result = session
            .web_read_from(
                &json!({"tab":"page","query":"measurement","start_chunk":cursor}),
                Some(live()),
                true,
                &cancellation,
            )
            .await
            .unwrap();
        let passages = result["passages"].as_array().unwrap();
        assert!(!passages.is_empty(), "{result}");
        assert!(
            passages
                .iter()
                .map(|p| p["text"].as_str().unwrap().encode_utf16().count())
                .sum::<usize>()
                <= 2000
        );
        for passage in passages {
            let chunk = passage["chunk"].as_u64().unwrap();
            let start = usize::try_from(passage["span"][0].as_u64().unwrap()).unwrap();
            let end = usize::try_from(passage["span"][1].as_u64().unwrap()).unwrap();
            assert!(
                seen.insert((chunk, start, end)),
                "continuation repeated a passage"
            );
            let full = session
                .web_read_from(
                    &json!({"tab":"page","start_chunk":chunk,"max_chars":2000}),
                    Some(live()),
                    true,
                    &cancellation,
                )
                .await
                .unwrap();
            // Repeated ordered windows may be referenced by hash; use a fresh
            // runtime turn to retrieve the exact full chunk independently.
            let full = if full["unchanged"] == true {
                access
                    .session_for_turn(String::new())
                    .web_read_from(
                        &json!({"tab":"page","start_chunk":chunk}),
                        Some(live()),
                        true,
                        &cancellation,
                    )
                    .await
                    .unwrap()
            } else {
                full
            };
            let text = full["markdown"].as_str().unwrap();
            assert_eq!(
                passage["text"],
                text.chars()
                    .skip(start)
                    .take(end - start)
                    .collect::<String>()
            );
            reached_footer |= passage["text"].as_str().unwrap().contains("91");
        }
        if result["next_start_chunk"].is_null() {
            break;
        }
        let next = result["next_start_chunk"].as_u64().unwrap();
        assert_eq!(next, cursor + passages.len() as u64);
        cursor = next;
    }
    assert!(seen.len() > 3);
    assert!(reached_footer, "chrome remains queryable");
    drop(session);
    drop(access);
    sandbox.mark_success();
    Ok(())
}
