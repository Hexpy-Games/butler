//! The scripted browser host: each observation serves the next page state,
//! and a tab read serves the reading text of the newest one as HTML.
use super::{STATES, fixture};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};

pub(super) async fn serve(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    let mut observed = 0usize;
    while let Some(frame) =
        super::super::browser_prefix::next_frame(&mut stream, &mut buffer).await?
    {
        let op = frame["op"].as_str().unwrap().to_owned();
        let current = &STATES[observed.saturating_sub(1).min(STATES.len() - 1)];
        let result = match op.as_str() {
            "use.started" | "use.ended" | "use.finished" => continue,
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                publish(&admin, STATES[0].url, STATES[0].epoch).await?;
                json!({"status":"ok","tab":"t1","url":STATES[0].url})
            }
            "tab.observe" => {
                let state = &STATES[observed];
                observed += 1;
                publish(&admin, state.url, state.epoch).await?;
                observation(observed, state)
            }
            "tab.prepare" => json!({"status":"ok","tab":"t1","url":current.url,
                "steps":[{"hit":{"role":"button","name":"","frame":""}}]}),
            "tab.act" => json!({"status":"ok","tab":"t1","completed":1,
                "steps":[{"status":"completed","hit":{"role":"button","name":"","frame":""}}]}),
            "tabs.list" => json!({"status":"ok","tabs":[tab(current.url, current.epoch)]}),
            "tab.read" => json!({"status":"ok","url":current.url,"epoch":current.epoch,
                "html":html(&fixture(current.fixture))}),
            _ => panic!("unexpected browser op {op}"),
        };
        let path = format!(
            "/internal/browser-host/results/{}",
            frame["id"].as_str().unwrap()
        );
        let response = admin.send(Method::POST, &path, Some(result), &[]).await?;
        assert_eq!(response.status, 200, "{}", response.text);
    }
    Ok(())
}

fn tab(url: &str, epoch: u64) -> Value {
    json!({"id":"t1","owner":"conversation:general","profile":"signed_out","epoch":epoch,
        "holder":"agent","inUse":false,"url":url})
}

async fn publish(admin: &AdminClient, url: &str, epoch: u64) -> Result<(), HarnessError> {
    admin
        .send(
            Method::POST,
            "/internal/browser-host/events",
            Some(json!({"tabs":[tab(url, epoch)]})),
            &[],
        )
        .await?;
    Ok(())
}

/// The fixture with its head naming this observation, plus the editable
/// fields the page lists (as the App reports them).
fn observation(obs: usize, state: &super::State) -> Value {
    let raw = fixture(state.fixture);
    let body = raw.split_once('\n').map_or("", |(_, body)| body);
    let text = format!("tab t1 epoch {} obs o{obs}\n{body}", state.epoch);
    let fields: Vec<Value> = raw
        .lines()
        .filter(|line| line.starts_with(|c: char| c.is_ascii_digit()) && line.contains(". "))
        .enumerate()
        .map(|(index, line)| json!({"position":index + 1,"line":line}))
        .collect();
    json!({"status":"ok","tab":"t1","obs":format!("o{obs}"),"url":state.url,"text":text,
        "fields":fields,"frames":[{"id":"f0","url":state.url}]})
}

/// Reading text of a fixture: its lines that are not elements or meta lines.
fn html(raw: &str) -> String {
    let paragraphs: String = raw
        .lines()
        .skip(1)
        .filter(|line| !line.contains(" [f") && !line.starts_with("interactive "))
        .filter(|line| !line.starts_with("Node rects") && !line.starts_with("Visible editable"))
        .flat_map(|line| ["<p>", line, "</p>"])
        .collect();
    format!(
        "<html><head><title>Fixture</title></head><body><main>{paragraphs}</main></body></html>"
    )
}
