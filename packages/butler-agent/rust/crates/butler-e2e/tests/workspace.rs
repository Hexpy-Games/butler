//! I. Workspace files and sidebar space (SCENARIOS.md WS-01, WS-02).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::path::Path;

use butler_e2e::e2e::faults::{ArgsMutation, Fault, Transform};
use butler_e2e::e2e::gateway::{Reply, tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, nonce, sha256_hex};
use serde_json::{Value, json};

async fn new_chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind": "chat", "title": title}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(format!(
        "s:{}",
        reply.data()["session"]["id"].as_str().unwrap_or_default()
    ))
}

async fn space(s: &Scenario) -> Result<Value, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{}", navigation.text);
    Ok(navigation.data()["space"].clone())
}

fn revision(space: &Value) -> i64 {
    space["revision"].as_i64().unwrap_or_default()
}

/// Keys of the children of `parent` (`None`: root), in sidebar order.
fn children(space: &Value, parent: Option<&str>) -> Vec<String> {
    let mut nodes: Vec<&Value> = space["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|node| node["parentKey"].as_str() == parent)
        .collect();
    nodes.sort_by(|a, b| {
        a["position"]
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&b["position"].as_f64().unwrap_or_default())
    });
    nodes
        .iter()
        .filter_map(|node| node["key"].as_str().map(str::to_owned))
        .collect()
}

/// `pinned` of a session's `/navigation` chat summary (`key` is `s:<id>`).
async fn pinned(s: &Scenario, key: &str) -> Result<bool, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    let id = key.trim_start_matches("s:");
    let chat = navigation.data()["chats"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|chat| chat["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("{id} missing from /navigation chats"));
    Ok(chat["pinned"] == true)
}

async fn mutate(s: &Scenario, path: &str, body: Value) -> Result<Reply, HarnessError> {
    let reply = s.gw.post(path, body).await?;
    assert_eq!(reply.status, 200, "{path}: {}", reply.text);
    Ok(reply)
}

/// Moves `gamma` after `beta` at the root, checks the order, and undoes it;
/// returns the space after the undo.
async fn reorder_and_undo(
    s: &Scenario,
    view: &Value,
    beta: &str,
    gamma: &str,
) -> Result<Value, HarnessError> {
    let before_move = children(view, None);
    let moved = mutate(
        s,
        "/space/moves",
        json!({"expectedRevision": revision(view), "sourceKey": gamma, "targetKey": beta, "position": "after"}),
    )
    .await?;
    let moved_view = space(s).await?;
    let order = children(&moved_view, None);
    let position = |key: &str| order.iter().position(|k| k == key).unwrap();
    assert_eq!(position(gamma), position(beta) + 1, "{order:?}");
    let token = moved.data()["undoToken"].as_str().unwrap().to_owned();
    mutate(
        s,
        "/space/undo",
        json!({"expectedRevision": revision(&moved_view), "undoToken": token}),
    )
    .await?;
    let undone = space(s).await?;
    assert_eq!(
        children(&undone, None),
        before_move,
        "undo did not restore the order"
    );
    Ok(undone)
}

/// WS-02 — Sidebar groups, moves, pins and undo show in `/navigation` and
/// persist; a stale revision changes nothing.
#[tokio::test]
async fn ws_02_sidebar_groups_moves_pins_undo() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WS-02")?.start().await?;
    let alpha = new_chat(&s, "Alpha").await?;
    let beta = new_chat(&s, "Beta").await?;
    let gamma = new_chat(&s, "Gamma").await?;

    let created = mutate(
        &s,
        "/space/groups",
        json!({"expectedRevision": revision(&space(&s).await?), "title": "Garden", "parentKey": null}),
    )
    .await?;
    let group = format!("g:{}", created.data()["groupId"].as_str().unwrap());
    let view = space(&s).await?;
    assert!(
        view["groups"].to_string().contains("Garden") && children(&view, None).contains(&group),
        "{view}"
    );

    mutate(
        &s,
        "/space/moves",
        json!({"expectedRevision": revision(&view), "sourceKey": alpha, "targetKey": group, "position": "inside"}),
    )
    .await?;
    let view = space(&s).await?;
    assert_eq!(children(&view, Some(&group)), vec![alpha.clone()], "{view}");
    assert!(!children(&view, None).contains(&alpha));

    let view = reorder_and_undo(&s, &view, &beta, &gamma).await?;

    let stale = s
        .gw
        .post(
            "/space/moves",
            json!({"expectedRevision": revision(&view) - 1, "sourceKey": beta, "targetKey": group, "position": "inside"}),
        )
        .await?;
    assert!(
        (400..500).contains(&stale.status),
        "stale revision accepted: {}",
        stale.text
    );
    assert_eq!(space(&s).await?, view, "a rejected move changed the space");

    mutate(
        &s,
        "/space/pins",
        json!({"expectedRevision": revision(&view), "nodeKey": beta, "pinned": true}),
    )
    .await?;
    let view = space(&s).await?;
    assert!(pinned(&s, &beta).await?, "pin not shown in /navigation");

    s.restart().await?;
    assert_eq!(space(&s).await?, view, "space changed across restart");
    assert!(pinned(&s, &beta).await?, "pin lost across restart");
    s.finish().await
}

/// Relative path + content hash of every file under `root`.
fn tree(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        out.push((
            entry.file_name().to_string_lossy().into_owned(),
            sha256_hex(&fs::read(&path).unwrap_or_default()),
        ));
    }
    out.sort();
    out
}

const WS_01_PROMPT: &str = "In the ws folder of your workspace: list the files, read utf8.txt, crlf.txt and binary.bin, and read only the beginning of large.log. Tell me the code words in utf8.txt and crlf.txt, the marker at the top of large.log, and what binary.bin is.";

/// `W/ws` with a multi-byte UTF-8 file, a CRLF file, a binary file and a
/// 50 MB log, each text file carrying its own per-run code.
struct EdgeFiles {
    setup: Setup,
    utf8: String,
    crlf_code: String,
    large_code: String,
}

fn edge_files(id: &str) -> Result<EdgeFiles, HarnessError> {
    let (utf8_code, crlf_code, large_code) = (nonce(), nonce(), nonce());
    let setup = Setup::new(id)?
        .cassette("WS-01")
        .placeholder("NONCE", &utf8_code)
        .placeholder("NONCE_CRLF", &crlf_code)
        .placeholder("NONCE_LARGE", &large_code);
    let dir = setup.sandbox.data.join("ws");
    fs::create_dir_all(&dir)?;
    let utf8 = format!("정원 일지 🌱 — code word: {utf8_code}\nCafé crème, naïve façade.\n");
    fs::write(dir.join("utf8.txt"), &utf8)?;
    fs::write(
        dir.join("crlf.txt"),
        format!("first line\r\ncode word: {crlf_code}\r\nlast line\r\n"),
    )?;
    let binary: Vec<u8> = (0..4096u32)
        .map(|i| i.wrapping_mul(2_654_435_761).to_be_bytes()[1])
        .collect();
    fs::write(dir.join("binary.bin"), &binary)?;
    let mut large = format!("marker: {large_code}\n");
    let line = "2026-09-27T00:00:00Z INFO garden sensor reading ok, humidity 61 percent\n";
    while large.len() < 50 * 1024 * 1024 {
        large.push_str(line);
    }
    fs::write(dir.join("large.log"), &large)?;
    Ok(EdgeFiles {
        setup,
        utf8,
        crlf_code,
        large_code,
    })
}

/// Per-file results of the turn's `read_file` call.
async fn read_results(s: &Scenario, turn_id: &str) -> Result<Vec<Value>, HarnessError> {
    let rows = tool_rows(&s.gw.messages("general").await?, turn_id);
    let read = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "read_file")
        .unwrap_or_else(|| panic!("no read_file call: {rows:#?}"));
    let output: Value = serde_json::from_str(&s.gw.operation_output(turn_id, read).await?)
        .unwrap_or_else(|error| panic!("read_file output is not JSON: {error}"));
    Ok(output["files"].as_array().cloned().unwrap_or_default())
}

fn file<'a>(results: &'a [Value], path: &str) -> &'a Value {
    results
        .iter()
        .find(|result| result["path"] == path)
        .unwrap_or_else(|| panic!("{path} not read: {results:#?}"))
}

/// No replacement characters anywhere the user sees the turn.
async fn assert_no_mojibake(s: &Scenario) -> Result<(), HarnessError> {
    let messages = s.gw.get("/messages?chat_id=general").await?;
    assert!(
        !messages.text.contains('\u{FFFD}'),
        "mojibake in the transcript"
    );
    Ok(())
}

/// WS-01 — Workspace file edge cases: every file (binary and 50 MB log
/// included) is listed with its size, multi-byte UTF-8 text is read exactly,
/// the CRLF file's line is read, the log read starts at its first line, no
/// U+FFFD reaches the transcript, and nothing is written to the workspace.
/// (The recorded `read_file` call asks for only the first lines of the log
/// and never reads binary.bin, so the product's own output bound and binary
/// rejection are proven by the injected variant below.)
#[tokio::test]
async fn ws_01_workspace_file_edge_cases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let files = edge_files("WS-01")?;
    let dir = files.setup.sandbox.data.join("ws");
    let before = tree(&dir);
    let s = files.setup.start().await?;
    let (turn_id, turn) = s.turn("general", WS_01_PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");

    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let list = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "list_files")
        .unwrap_or_else(|| panic!("no list_files call: {rows:#?}"));
    let listed: Value = serde_json::from_str(&s.gw.operation_output(&turn_id, list).await?)?;
    let sizes: Vec<(String, u64)> = listed["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            (
                entry["path"].as_str().unwrap_or_default().to_owned(),
                entry["bytes"].as_u64().unwrap_or_default(),
            )
        })
        .collect();
    for (name, _) in &before {
        let size = fs::metadata(dir.join(name))?.len();
        assert!(
            sizes.contains(&(format!("ws/{name}"), size)),
            "{name} ({size} bytes) not listed: {sizes:?}"
        );
    }

    let results = read_results(&s, &turn_id).await?;
    assert_eq!(
        file(&results, "ws/utf8.txt")["content"],
        files.utf8.as_str()
    );
    let crlf = file(&results, "ws/crlf.txt")["content"]
        .as_str()
        .unwrap_or_default();
    assert!(
        crlf.contains(&format!("code word: {}", files.crlf_code)),
        "{crlf:?}"
    );
    let large = file(&results, "ws/large.log");
    let content = large["content"].as_str().unwrap_or_default();
    assert!(
        content.starts_with(&format!("marker: {}", files.large_code)),
        "{large}"
    );
    assert_no_mojibake(&s).await?;
    assert_eq!(tree(&dir), before, "the workspace changed");
    s.finish().await
}

/// WS-01 (inject) — the recorded `read_file` call rewritten to request the
/// binary file and an unbounded slice of the 50 MB log: the binary file is
/// reported as not UTF-8 (no mojibake), and the log read is cut at the
/// output budget and says so.
#[tokio::test]
async fn ws_01_binary_and_oversized_reads_are_reported() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let files = edge_files("WS-01-INJECT")?;
    let s = files.setup.replay_only().start().await?;
    s.provider()?.inject(Fault::first_call(
        "In the ws folder",
        Transform::MutateToolArgs(ArgsMutation::OnlyTool {
            tool: "read_file".into(),
            mutation: Box::new(ArgsMutation::Edits(vec![
                ("ws/crlf.txt".into(), "ws/binary.bin".into()),
                (
                    r#""limit_lines":8,"max_bytes":2048"#.into(),
                    r#""limit_lines":1000000"#.into(),
                ),
            ])),
        }),
    ))?;
    let (turn_id, turn) = s.turn("general", WS_01_PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let results = read_results(&s, &turn_id).await?;
    let binary = file(&results, "ws/binary.bin");
    assert_eq!(binary["ok"], false, "{binary}");
    assert_eq!(binary["error"], "binary_file_not_supported", "{binary}");
    assert!(
        binary["content"].is_null(),
        "binary bytes shown as text: {binary}"
    );
    let large = file(&results, "ws/large.log");
    assert_eq!(large["truncated"], true, "{large}");
    let content = large["content"].as_str().unwrap_or_default();
    assert!(content.starts_with(&format!("marker: {}", files.large_code)));
    assert!(content.len() < 64 * 1024, "the 50 MB read was not bounded");
    // The slice says where it stopped, so the next page can be requested.
    let end = large["end_line"].as_u64().unwrap_or_default();
    assert!(end > 1 && end < 1_000_000, "{large}");
    assert_eq!(
        content.lines().count() as u64,
        end,
        "end_line does not match the slice"
    );
    assert_no_mojibake(&s).await?;
    s.finish().await
}
