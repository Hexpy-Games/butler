//! Observation text v2 and tab re-reads, through the real tool path with a
//! scripted browser host serving a generic fixture page set (a store listing,
//! a product page and an article). Every observation the model receives must
//! leave it holding exactly the page's refs: full listings re-list them,
//! change lists add, change and remove them against the previous view, and a
//! page that reorders, navigates or is asked for in full comes back whole.
//! A tab re-read answers "unchanged" only for identical content.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod host;

use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// One scripted page state: fixture, URL, epoch, and how the model should get it.
pub(super) struct State {
    pub fixture: &'static str,
    pub url: &'static str,
    pub epoch: u64,
    mode: Mode,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Full,
    Delta,
    Unchanged,
}

const SHOP: &str = "https://shop.example/search";
const ITEM: &str = "https://shop.example/item";
const NEWS: &str = "https://news.example/market";

pub(super) const STATES: [State; 11] = [
    state("listing", SHOP, 3, Mode::Full),
    state("listing_typed", SHOP, 3, Mode::Delta),
    state("listing_more", SHOP, 3, Mode::Delta),
    state("listing_dialog", SHOP, 3, Mode::Delta),
    state("listing_dialog", SHOP, 3, Mode::Unchanged),
    state("listing_sorted", SHOP, 3, Mode::Full),
    state("product", ITEM, 1, Mode::Full),
    state("product_qty", ITEM, 1, Mode::Delta),
    state("product_qty", ITEM, 1, Mode::Full),
    state("article", NEWS, 1, Mode::Full),
    state("article_update", NEWS, 1, Mode::Delta),
];

const fn state(fixture: &'static str, url: &'static str, epoch: u64, mode: Mode) -> State {
    State {
        fixture,
        url,
        epoch,
        mode,
    }
}

pub(super) fn fixture(name: &str) -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/observation-v2");
    std::fs::read_to_string(root.join(format!("{name}.txt"))).unwrap()
}

#[tokio::test]
async fn observation_v2_keeps_every_ref_and_rereads_only_identical_pages()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-OBSERVATION-V2")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let served = tokio::spawn(host::serve(stream, admin));
    let (_, turn) = s.turn("general", "Compare the store pages").await?;
    assert_eq!(turn["state"], "delivered");
    let requests = s.provider()?.requests();
    let last = requests.last().unwrap();
    let observations = super::browser_prefix::outputs(last);
    assert_eq!(
        observations.len(),
        STATES.len(),
        "one observation per state"
    );
    let (raw, seen) = assert_views(&observations);
    eprintln!(
        "OBSERVATION_V2 raw_bytes={raw} model_bytes={seen} ratio={:.3}",
        seen as f64 / raw as f64
    );
    assert!(seen * 10 <= raw * 7, "v2 text {seen} B vs raw {raw} B");
    served.abort();
    let _ = served.await;
    s.finish().await
}

/// Walks the observations in order, keeping the ref set the model holds.
fn assert_views(observations: &[(Value, bool)]) -> (usize, usize) {
    let mut held: BTreeMap<String, String> = BTreeMap::new();
    let mut base: Option<BTreeMap<String, String>> = None;
    let (mut raw_bytes, mut seen_bytes) = (0, 0);
    for (index, ((value, _), state)) in observations.iter().zip(&STATES).enumerate() {
        let output = &value["output"];
        let text = output["untrusted_content"]["text"].as_str().unwrap();
        let raw = fixture(state.fixture);
        let page = lines(&raw);
        raw_bytes += raw.len();
        seen_bytes += text.len();
        let delta = output.get("delta_of").is_some();
        let mode = match (delta, text.contains("No change since")) {
            (false, _) => Mode::Full,
            (true, false) => Mode::Delta,
            (true, true) => Mode::Unchanged,
        };
        assert_eq!(mode, state.mode, "state {index}: {text}");
        if delta {
            let previous = base.as_ref().unwrap();
            for (reference, line) in &page {
                if previous.get(reference) != Some(line) {
                    assert!(
                        text.contains(&format!("[{reference}]")),
                        "state {index}: changed {reference} must be listed"
                    );
                }
            }
            for reference in removed(text) {
                held.remove(&reference);
            }
        } else {
            held.clear();
        }
        for reference in refs(text) {
            held.insert(reference, String::new());
        }
        let expected: BTreeSet<_> = page.keys().cloned().collect();
        let holds: BTreeSet<_> = held.keys().cloned().collect();
        assert_eq!(
            holds, expected,
            "state {index}: the model holds exactly the page's refs"
        );
        base = Some(page);
    }
    (raw_bytes, seen_bytes)
}

/// `ref -> line` of every element line in raw observation text.
pub(super) fn lines(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| element_ref(line).map(|r| (r, line.to_owned())))
        .collect()
}

fn element_ref(line: &str) -> Option<String> {
    let start = line.find(" [f")? + 2;
    let end = start + line[start..].find(']')?;
    let reference = &line[start..end];
    let valid = reference.contains("-e") && !line.starts_with(char::is_numeric);
    valid.then(|| reference.to_owned())
}

fn refs(text: &str) -> Vec<String> {
    text.lines().filter_map(element_ref).collect()
}

fn removed(text: &str) -> Vec<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("Removed elements: "))
        .map(|list| list.split(", ").map(str::to_owned).collect())
        .unwrap_or_default()
}

fn act(observation: usize, steps: &Value) -> (&'static str, Value) {
    (
        "browser_act",
        json!({"tab":"t1","observation":format!("o{observation}"),"observe":true,"steps":steps}),
    )
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = vec![
        (
            "tool_describe",
            json!({"ids":["native:browser_open","native:browser_observe","native:browser_act"]}),
        ),
        ("browser_open", json!({"url":SHOP})),
        ("browser_observe", json!({"tab":"t1"})),
        act(
            1,
            &json!([{"action":"fill","ref":"f0-e4","value":"linen bag xl"}]),
        ),
        act(2, &json!([{"action":"click","ref":"f0-e20"}])),
        act(3, &json!([{"action":"click","ref":"f0-e21"}])),
        ("browser_observe", json!({"tab":"t1"})),
        act(
            5,
            &json!([{"action":"click","ref":"f0-e31"},{"action":"click","ref":"f0-e9"}]),
        ),
        act(6, &json!([{"action":"click","ref":"f0-e16"}])),
        act(
            7,
            &json!([{"action":"fill","ref":"f0-e10","value":"2"},{"action":"click","ref":"f0-e8"}]),
        ),
        ("browser_observe", json!({"tab":"t1","full":true})),
        act(9, &json!([{"action":"click","ref":"f0-e1"}])),
        act(10, &json!([{"action":"click","ref":"f0-e5"}])),
    ];
    super::browser_prefix::add_turn(
        &mut cassette,
        &template,
        "Compare the store pages",
        calls,
        "Compared the pages",
    );
    Ok(cassette)
}
