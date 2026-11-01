//! DELEG-BATCH — a delegated research task whose steward batches its
//! independent reads takes fewer model rounds and input tokens than the same
//! research one read per round, and receives exactly the same page content.
//! A scripted parent and steward, an offline search fixture and this test as
//! the App browser host; no network.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod model;

use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// What one run of the research cost and what its steward learned.
struct Run {
    /// Per steward request: (input tokens, of which a cached prefix, output tokens).
    steward: Vec<(usize, usize, usize)>,
    /// Steward requests that carried more than one call.
    batched_rounds: usize,
    /// Every page window the steward read: (tab, start chunk, text).
    reads: Vec<(String, u64, String)>,
    /// The steward's report as Butler received it.
    report: String,
    instructions: String,
    /// The next step `web_search` and `browser_open` gave the steward.
    guidance: [String; 2],
}

#[tokio::test]
async fn deleg_batch_01_batched_reads_take_fewer_rounds_with_the_same_content()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let serial = research(false).await?;
    let batched = research(true).await?;
    eprintln!(
        "DELEG-BATCH steward cost: {}",
        json!({"serial":cost(&serial),"batched":cost(&batched)})
    );

    // The steward is told to batch independent reads, and the search and
    // open results name the reads that can share the next round.
    assert!(
        batched.instructions.contains("independent reads"),
        "{}",
        batched.instructions
    );
    for next in &batched.guidance {
        assert!(next.contains("browser_observe"), "{next}");
    }
    // The same facts: every page window, and the report Butler got.
    assert_eq!(serial.reads.len(), 3, "{:?}", serial.reads);
    assert_eq!(batched.reads, serial.reads);
    for (tab, start, text) in &batched.reads {
        assert!(text.contains("6.1 m") || *start > 0, "{tab}: {text}");
        if *start > 0 {
            assert!(text.contains("End of the tide table."), "{tab}: {text}");
        }
    }
    assert_eq!(batched.report, serial.report);
    assert!(batched.report.contains(model::REPORT), "{}", batched.report);

    // Fewer rounds and fewer input tokens; the prefix stays append-only.
    assert_eq!(serial.batched_rounds, 0);
    assert_eq!(batched.batched_rounds, 1);
    assert_eq!(serial.steward.len() - batched.steward.len(), 2);
    let input = |run: &Run| run.steward.iter().map(|r| r.0).sum::<usize>();
    assert!(input(&batched) < input(&serial));
    for run in [&serial, &batched] {
        for window in run.steward.windows(2) {
            assert!(
                window[1].1 >= window[0].0,
                "prefix rewritten: {:?}",
                run.steward
            );
        }
    }
    Ok(())
}

async fn research(batched: bool) -> Result<Run, HarnessError> {
    let (url, script, server) = model::start(batched).await?;
    let s = Setup::new(if batched {
        "DELEG-BATCH-BATCHED"
    } else {
        "DELEG-BATCH-SERIAL"
    })?
    .stub_cassette(Cassette::load("TOOL-01")?)
    .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
    .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key")
    .start()
    .await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"brave","planning":{"enabled":false},
        "braveApiBase":format!("{url}/search")});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = super::search_browser::host::Host::attach(admin).await?;
    let served = tokio::spawn(host.serve());
    s.turn("general", model::REQUEST).await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let done = view.data()["active_turn"].is_null()
            && view.data()["steward_children"]
                .as_array()
                .unwrap()
                .iter()
                .any(|child| child["result"]["status"] == "success")
            && script
                .exchanges
                .lock()
                .unwrap()
                .iter()
                .any(|(child, _, items)| !child && items[0]["content"][0]["text"] == model::ANSWER);
        if done {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delegation did not finish: {}\n{}",
            view.text,
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    served.abort();
    let run = measure(&script.exchanges.lock().unwrap())?;
    s.finish().await?;
    server.abort();
    Ok(run)
}

fn measure(exchanges: &[(bool, Value, Vec<Value>)]) -> Result<Run, HarnessError> {
    let tokenizer = tiktoken_rs::o200k_base().map_err(|e| HarnessError(e.to_string()))?;
    let count = |text: &str| tokenizer.encode_ordinary(text).len();
    let mut steward = Vec::new();
    let mut previous: Option<String> = None;
    let mut batched_rounds = 0;
    let mut last = None;
    for (_, body, items) in exchanges.iter().filter(|(child, ..)| *child) {
        // The provider's prefix order: instructions, tools, then the input.
        let mut prompt = format!("{}\n{}\n", body["instructions"], body["tools"]);
        for item in body["input"].as_array().unwrap() {
            prompt.push_str(&item.to_string());
            prompt.push('\n');
        }
        let cached = previous.as_deref().map_or(0, |previous| {
            let shared = previous
                .char_indices()
                .zip(prompt.chars())
                .take_while(|((_, a), b)| a == b)
                .last()
                .map_or(0, |((index, a), _)| index + a.len_utf8());
            count(&prompt[..shared])
        });
        let output = items
            .iter()
            .map(|item| {
                count(
                    item["arguments"]
                        .as_str()
                        .or(item["content"][0]["text"].as_str())
                        .unwrap_or(""),
                )
            })
            .sum();
        steward.push((count(&prompt), cached, output));
        batched_rounds += usize::from(items.len() > 1);
        previous = Some(prompt);
        last = Some(body);
    }
    let last = last.unwrap();
    let outputs = model::outputs(last);
    let mut reads = outputs
        .iter()
        .filter(|output| output["schema"] == "butler.browser-observation.v1")
        .map(read)
        .collect::<Vec<_>>();
    reads.sort();
    let next = |key: &str| {
        outputs
            .iter()
            .find(|output| output.get(key).is_some())
            .map_or(String::new(), |output| output["next"].to_string())
    };
    let report = exchanges
        .iter()
        .filter(|(child, ..)| !child)
        .filter_map(|(_, body, _)| {
            body["input"].as_array().unwrap().iter().find_map(|item| {
                let text = super::steward_presentation::stub::user_text(item);
                text.contains("Delegated result").then_some(text)
            })
        })
        .next_back()
        .unwrap_or_default();
    Ok(Run {
        steward,
        batched_rounds,
        reads,
        report,
        instructions: last["instructions"].as_str().unwrap_or_default().to_owned(),
        guidance: [next("results"), next("tabs")],
    })
}

fn read(output: &Value) -> (String, u64, String) {
    let url = output["untrusted_content"]["url"].as_str().unwrap();
    let text = output["untrusted_content"]["text"].as_str().unwrap();
    let prefix = format!("tab {} ", output["tab"].as_str().unwrap());
    assert!(text.starts_with(&prefix), "{output}");
    // Parallel opens assign different tab IDs; retain all text and metadata,
    // replacing only the verified tab identity with its logical source URL.
    (
        url.to_owned(),
        0,
        text.replacen(&prefix, &format!("tab {url} "), 1),
    )
}

/// Rounds, tokens and USD at the delegated demo model's catalog prices.
fn cost(run: &Run) -> Value {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap();
    let pricing = &catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["model_ref"] == "google/gemini-4-argon")
        .unwrap()["pricing"];
    let price = |key: &str| pricing[key].as_f64().unwrap() / 1e6;
    let input = run.steward.iter().map(|r| r.0).sum::<usize>();
    let cached = run.steward.iter().map(|r| r.1).sum::<usize>();
    let output = run.steward.iter().map(|r| r.2).sum::<usize>();
    let uncached = input - cached;
    let usd = |tokens: usize, key: &str| tokens as f64 * price(key);
    json!({"rounds":run.steward.len(),
        "inputPerRound":run.steward.iter().map(|r| r.0).collect::<Vec<_>>(),
        "input":input,"cached":cached,"uncached":uncached,"output":output,
        "usd":{"uncached":usd(uncached,"input_per_mtok_usd"),
            "cached":usd(cached,"cached_input_per_mtok_usd"),
            "output":usd(output,"output_per_mtok_usd"),
            "total":usd(uncached,"input_per_mtok_usd")+usd(cached,"cached_input_per_mtok_usd")
                +usd(output,"output_per_mtok_usd")}})
}
