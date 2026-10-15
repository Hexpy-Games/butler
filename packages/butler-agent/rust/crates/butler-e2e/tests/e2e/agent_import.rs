//! Import from other AI agents through the authenticated host API, with
//! fixture homes for Codex, Claude Code, OpenCode and Hermes: detection,
//! instructions (deduped on re-import and across agents), MCP servers with
//! secret values left behind as empty slots, and an exact undo.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod selection;
mod state;

use super::memory_fixture;
use butler_e2e::e2e::{
    HarnessError, fixtures,
    scenario::{Fixture, Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;

const CODEX_RULE: &str = "Answer every question with the word papaya-codex-417.";
const CLAUDE_RULE: &str = "Prefer short sentences. kiwi-claude-208";
const HERMES_SOUL: &str = "You are calm and precise. fig-hermes-951";

fn write(home: &Path, relative: &str, text: &str) {
    let path = home.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Every agent's files, each carrying secret canaries that must never be copied.
fn agent_homes(home: &Path) {
    write(home, ".codex/AGENTS.md", "Superseded by the override file.");
    write(home, ".codex/AGENTS.override.md", CODEX_RULE);
    write(home, ".codex/auth.json", r#"{"token":"canary-codex-auth"}"#);
    write(
        home,
        ".codex/config.toml",
        r#"model = "gpt-x"

[mcp_servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

[mcp_servers.github]
command = "docker"
args = ["run", "-i", "ghcr.io/github/github-mcp-server"]
env = { GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_canaryCodexEnv" }

[mcp_servers.leaky]
command = "tool"
args = ["--api-key", "canary-codex-arg"]
"#,
    );
    write(home, ".claude/CLAUDE.md", CLAUDE_RULE);
    write(
        home,
        ".claude/.credentials.json",
        "canary-claude-credentials",
    );
    write(
        home,
        ".claude.json",
        r#"{
  "oauthAccount": {"emailAddress": "canary-claude-account@example.test"},
  "projects": {"/work": {"mcpServers": {"project-only": {"command": "proj"}}}},
  "mcpServers": {
    "remote": {"type": "http", "url": "https://mcp.fixture.test/mcp",
               "headers": {"Authorization": "Bearer canary-claude-header"}},
    "files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}
  }
}"#,
    );
    write(
        home,
        ".config/opencode/AGENTS.md",
        &format!("\n{CODEX_RULE}\n"),
    );
    write(
        home,
        ".config/opencode/opencode.jsonc",
        r#"{
  // Local and remote servers; a token in the URL is never copied.
  "mcp": {
    "clock": {"type": "local", "command": ["uvx", "mcp-server-time"],
              "environment": {"TIME_KEY": "canary-opencode-env"}, "enabled": true,},
    /* remote */ "web": {"type": "remote", "url": "https://web.fixture.test/sse?token=canary-opencode-url"},
  },
}"#,
    );
    write(home, ".hermes/SOUL.md", HERMES_SOUL);
    write(home, ".hermes/.env", "OPENAI_API_KEY=canary-hermes-dotenv");
    write(
        home,
        ".hermes/config.yaml",
        r#"model:
  default: hermes-x
mcp_servers:
  # Same name as a Codex server, another command.
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_canaryHermesEnv"
  fetch:
    command: uvx
    args:
      - mcp-server-fetch
    tools:
      include: [fetch]
"#,
    );
}

async fn call(admin: &AdminClient, op: &str, body: Option<Value>) -> Result<Value, HarnessError> {
    let method = if body.is_some() {
        Method::POST
    } else {
        Method::GET
    };
    let reply = admin
        .send(method, &format!("/security/agent-import/{op}"), body, &[])
        .await?;
    assert_eq!(reply.status, 200, "{op}: {}", reply.text);
    Ok(reply.data().clone())
}

async fn start(admin: &AdminClient, source: &str) -> Result<Value, HarnessError> {
    call(admin, "start", Some(json!({"source": source}))).await
}

async fn instructions(s: &Scenario) -> Result<Vec<String>, HarnessError> {
    let list = s.gw.get("/memory/instructions").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    Ok(list.data()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["text"].as_str().unwrap().to_owned())
        .collect())
}

async fn servers(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let list = s.gw.get("/mcp-servers").await?;
    assert_eq!(list.status, 200, "{}", list.text);
    Ok(list.data()["servers"].as_array().unwrap().clone())
}

fn server<'a>(rows: &'a [Value], id: &str) -> &'a Value {
    rows.iter()
        .find(|row| row["id"] == id)
        .unwrap_or_else(|| panic!("server {id} missing: {rows:?}"))
}

fn slots(row: &Value, field: &str) -> Vec<(String, bool)> {
    row[field]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| {
            (
                slot["key"].as_str().unwrap().to_owned(),
                slot["has_value"] == true,
            )
        })
        .collect()
}

/// No canary from any source file reached Butler's registry or instructions.
async fn assert_no_secrets(s: &Scenario) -> Result<(), HarnessError> {
    let registry = std::fs::read_to_string(s.sandbox.data.join("config/mcp-servers.json"))?;
    assert!(
        !registry.contains("canary"),
        "registry holds a secret: {registry}"
    );
    for text in instructions(s).await? {
        assert!(!text.contains("canary"), "instruction holds a secret");
    }
    Ok(())
}

#[tokio::test]
async fn agent_import_detects_imports_dedupes_strips_secrets_and_undoes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("AGENT-IMPORT")?.fixture(Fixture::Empty);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let unauthorized = s.gw.get("/security/agent-import/sources").await?;
    assert_ne!(unauthorized.status, 200, "needs the admin credential");
    assert_eq!(call(&admin, "sources", None).await?["sources"], json!([]));

    agent_homes(&s.sandbox.home);
    let sources = call(&admin, "sources", None).await?;
    let row = |key: &str| {
        sources["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == key)
            .cloned()
            .unwrap_or_else(|| panic!("{key} not detected: {sources}"))
    };
    let expected = [
        ("codex", "~/.codex/AGENTS.override.md", 2, 1, 1),
        ("claude-code", "~/.claude/CLAUDE.md", 2, 1, 0),
        ("opencode", "~/.config/opencode/AGENTS.md", 1, 1, 1),
        ("hermes", "~/.hermes/SOUL.md", 2, 1, 0),
    ];
    for (key, file, found, secret, skipped) in expected {
        let row = row(key);
        assert_eq!(row["instructions"], true, "{row}");
        assert_eq!(row["instructions_file"], file, "{row}");
        assert_eq!(row["servers"], found, "{row}");
        assert_eq!(row["needs_secret"], secret, "{row}");
        assert_eq!(row["skipped"], skipped, "{row}");
    }
    assert!(!sources.to_string().contains("canary"));

    // Codex: the override file wins; the secret-bearing command is left out.
    let codex = start(&admin, "codex").await?;
    assert_eq!(
        (
            codex["instructions"].clone(),
            codex["servers"].clone(),
            codex["needs_secret"].clone(),
            codex["skipped"].clone()
        ),
        (json!(1), json!(2), json!(1), json!(1)),
        "{codex}"
    );
    let texts = instructions(&s).await?;
    assert!(
        texts.contains(&format!(
            "# From Codex (~/.codex/AGENTS.override.md)\n\n{CODEX_RULE}"
        )),
        "{texts:?}"
    );
    let rows = servers(&s).await?;
    assert_eq!(
        server(&rows, "files")["enabled"],
        true,
        "no secret: ready to use"
    );
    let github = server(&rows, "github");
    assert_eq!(
        github["enabled"], true,
        "keeps source on while waiting for its secret"
    );
    assert_eq!(
        slots(github, "env"),
        [("GITHUB_PERSONAL_ACCESS_TOKEN".to_owned(), false)]
    );
    assert_no_secrets(&s).await?;

    // Re-import adds nothing.
    let again = start(&admin, "codex").await?;
    assert_eq!(
        (
            again["instructions"].clone(),
            again["instructions_existing"].clone(),
            again["servers"].clone(),
            again["servers_existing"].clone()
        ),
        (json!(0), json!(1), json!(0), json!(2)),
        "{again}"
    );
    assert_eq!(instructions(&s).await?.len(), 1);

    // Claude Code: user-scope servers only; the shared filesystem server is a duplicate.
    let claude = start(&admin, "claude-code").await?;
    assert_eq!(
        (
            claude["instructions"].clone(),
            claude["servers"].clone(),
            claude["servers_existing"].clone(),
            claude["needs_secret"].clone()
        ),
        (json!(1), json!(1), json!(1), json!(1)),
        "{claude}"
    );
    let rows = servers(&s).await?;
    let remote = server(&rows, "remote");
    assert_eq!(
        (remote["transport"].clone(), remote["url"].clone()),
        (json!("http"), json!("https://mcp.fixture.test/mcp"))
    );
    assert_eq!(
        slots(remote, "headers"),
        [("Authorization".to_owned(), false)]
    );
    assert!(rows.iter().all(|row| row["id"] != "project-only"));

    // OpenCode: the same instruction body as Codex is not added twice.
    let opencode = start(&admin, "opencode").await?;
    assert_eq!(
        (
            opencode["instructions"].clone(),
            opencode["instructions_existing"].clone(),
            opencode["servers"].clone(),
            opencode["skipped"].clone()
        ),
        (json!(0), json!(1), json!(1), json!(1)),
        "{opencode}"
    );
    let rows = servers(&s).await?;
    let clock = server(&rows, "clock");
    assert_eq!(
        (clock["command"].clone(), clock["args"].clone()),
        (json!("uvx"), json!(["mcp-server-time"]))
    );
    assert_eq!(slots(clock, "env"), [("TIME_KEY".to_owned(), false)]);
    assert!(
        rows.iter().all(|row| row["id"] != "web"),
        "token in URL: set up by hand"
    );

    // Hermes: a taken name gets the agent suffix; tool filters keep it off.
    let hermes = start(&admin, "hermes").await?;
    assert_eq!(
        (hermes["instructions"].clone(), hermes["servers"].clone()),
        (json!(1), json!(2)),
        "{hermes}"
    );
    let rows = servers(&s).await?;
    assert_eq!(
        slots(server(&rows, "github-hermes"), "env"),
        [("GITHUB_TOKEN".to_owned(), false)]
    );
    assert_eq!(
        server(&rows, "fetch")["enabled"],
        false,
        "tool filters are not enforced yet"
    );
    assert_eq!(instructions(&s).await?.len(), 3);
    assert_eq!(rows.len(), 6);
    assert_no_secrets(&s).await?;

    // Undo removes exactly what each run added.
    let undone = call(&admin, "undo", Some(json!({"run_id": hermes["run_id"]}))).await?;
    assert_eq!(undone, json!({"instructions": 1, "servers": 2}));
    let texts = instructions(&s).await?;
    assert_eq!(texts.len(), 2);
    assert!(texts.iter().all(|text| !text.contains(HERMES_SOUL)));
    let rows = servers(&s).await?;
    assert!(
        rows.iter()
            .all(|row| row["id"] != "github-hermes" && row["id"] != "fetch")
    );
    let nothing = call(&admin, "undo", Some(json!({"run_id": again["run_id"]}))).await?;
    assert_eq!(
        nothing,
        json!({"instructions": 0, "servers": 0}),
        "the re-import owns nothing"
    );
    let first = call(&admin, "undo", Some(json!({"run_id": codex["run_id"]}))).await?;
    assert_eq!(first, json!({"instructions": 1, "servers": 2}));
    let rows = servers(&s).await?;
    let ids: Vec<&str> = rows.iter().map(|row| row["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert!(ids.contains(&"remote") && ids.contains(&"clock"), "{ids:?}");
    assert_eq!(
        instructions(&s).await?,
        [format!(
            "# From Claude Code (~/.claude/CLAUDE.md)\n\n{CLAUDE_RULE}"
        )]
    );
    let repeat = call(&admin, "undo", Some(json!({"run_id": codex["run_id"]}))).await?;
    assert_eq!(repeat, json!({"instructions": 0, "servers": 0}));
    s.finish().await
}
