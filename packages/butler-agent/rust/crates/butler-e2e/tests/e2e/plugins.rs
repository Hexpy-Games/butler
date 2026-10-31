//! Consent, integrity and lifecycle of local packages through admin HTTP routes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod git;
mod git_support;
mod git_timeout;
mod growth;
mod hook_context;
mod idle;
mod inspection;
mod lifecycle;
mod round_two;
mod security;
mod stub;
mod updates;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::Reply,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn setup(name: &str) -> Result<Setup, HarnessError> {
    Ok(Setup::new(name)?.stub_cassette(Cassette::load("TOOL-01")?))
}
async fn api(
    s: &Scenario,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Reply, HarnessError> {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
        .send(method, path, body, &[])
        .await
}
fn package(home: &Path, id: &str) -> Result<PathBuf, HarnessError> {
    let root = home.join(id);
    fs::create_dir_all(root.join("skills/notes"))?;
    fs::write(root.join("plugin.json"),json!({"name":id,"version":"1.2.3","author":{"name":"Unverified author"},"extensions":{"io.github.hexpy-games.butler":{"api":1,"hooks":"hooks.json"}}}).to_string())?;
    fs::write(
        root.join("skills/notes/SKILL.md"),
        "---\nname: notes\ndescription: Read package notes\nallowed-tools: run_command\n---\nPackage skill instructions.\n",
    )?;
    let fixture = butler_e2e::e2e::binary::mcp_fixture_binary()?;
    fs::copy(fixture, root.join("server.exe"))?;
    fs::write(root.join("mcp.json"),json!({"mcpServers":{"notes":{"command":"${BUTLER_PLUGIN_ROOT}/server.exe","env":{"E2E_MCP_NONCE":"package-output","E2E_MCP_STARTED_FILE":"${BUTLER_PLUGIN_DATA}/mcp-started"}}}}).to_string())?;
    let args = if butler_platform::command_sandbox::POSIX_SHELL {
        fs::write(
            root.join("allow.sh"),
            "#!/bin/sh\nprintf '%s\\n' '{\"decision\":\"allow\"}'\nprintf ran >> hook-ran\n",
        )?;
        vec!["sh", "${BUTLER_PLUGIN_ROOT}/allow.sh"]
    } else {
        fs::write(
            root.join("allow.cmd"),
            "@echo off\r\necho {\"decision\":\"allow\"}\r\necho ran >> hook-ran\r\n",
        )?;
        vec![
            "cmd.exe",
            "/d",
            "/s",
            "/c",
            "${BUTLER_PLUGIN_ROOT}/allow.cmd",
        ]
    };
    fs::write(root.join("hooks.json"),json!({"version":1,"hooks":[{"id":"allow","type":"command","event":"PreToolUse","args":args}]}).to_string())?;
    Ok(root)
}
async fn inspect(s: &Scenario, path: &Path) -> Result<Value, HarnessError> {
    let r = api(
        s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"path":path})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(r.data().clone())
}
async fn revision(s: &Scenario) -> Result<u64, HarnessError> {
    Ok(
        api(s, Method::GET, "/plugins", None).await?.data()["revision"]
            .as_u64()
            .unwrap(),
    )
}
async fn install(s: &Scenario, path: &Path) -> Result<Value, HarnessError> {
    let i = inspect(s, path).await?;
    let r=api(s,Method::POST,"/plugins/install",Some(json!({"staging_id":i["staging_id"],"digest":i["digest"],"revision":revision(s).await?,"secrets":{}}))).await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(i)
}
