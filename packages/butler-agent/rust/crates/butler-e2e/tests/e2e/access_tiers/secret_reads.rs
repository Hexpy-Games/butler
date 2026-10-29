//! PERM-SECRETS: an approved command runs with the user's access, but the
//! kernel keeps Butler's secrets and the user's credential stores unreadable,
//! whatever shell construct names them. A host that cannot deny those reads
//! asks for every command the lexical guard cannot resolve, with a card that
//! says it runs without a sandbox; a standing permission never covers it.
mod ssh;

use super::stub::{self, Script, call};
use super::{approve, delivered, outputs, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const KEY: &str = "fixture-private-key";
const REASON: &str = "authority.unsandboxedReason";

fn mutation(id: &str, command: &str) -> Value {
    call(
        id,
        "run_command",
        &json!({"command":command,"summary":"Run step","state_effect":"mutation"}),
    )
}

#[tokio::test]
async fn approved_commands_cannot_read_secrets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::secret_reads_deniable(),
        "Requires kernel credential-read denial for approved commands"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-SECRETS")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let home = setup.sandbox.home.clone();
    std::fs::create_dir_all(home.join(".ssh"))?;
    // A plain name: the lexical guard already refuses key-like names.
    std::fs::write(home.join(".ssh/deploy-login"), KEY)?;
    std::fs::create_dir_all(setup.sandbox.data.join("auth"))?;
    std::fs::write(setup.sandbox.data.join("auth/provider.json"), KEY)?;
    let folder = home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(&project)?;
    // Each spelling escapes the lexical guard; only the kernel stops it.
    let hidden = [
        (
            "substitution",
            r#"cat "$(printf '%s/.s%s/deploy-login' "$HOME" sh)""#,
        ),
        (
            "symlink",
            r#"d=.ss; ln -s "$HOME/${d}h" keys && cat keys/deploy-login"#,
        ),
        (
            "variable",
            r#"f=au; cat "$BUTLER_DATA/${f}th/provider.json""#,
        ),
        (
            "rename",
            r#"d=.ss; mv "$HOME/${d}h" "$HOME/moved"; cat "$HOME/moved/deploy-login""#,
        ),
    ];
    for (id, command) in hidden {
        let output = approved(&s, &chat, &script, id, command).await?;
        assert!(!output.contains(KEY), "{id} printed the secret: {output}");
        assert!(output.contains("credential_reads_denied"), "{id}: {output}");
        assert!(output.contains("Operation not permitted"), "{id}: {output}");
        assert!(output.contains(r#"sandbox \"none\""#), "{id}: {output}");
    }
    assert!(home.join(".ssh/deploy-login").is_file() && !home.join("moved").exists());
    // The literal spelling never reaches a shell: the guard refuses it first.
    let output = approved(
        &s,
        &chat,
        &script,
        "direct",
        r#"cat "$HOME/.ssh/deploy-login""#,
    )
    .await?;
    assert!(!output.contains(KEY), "{output}");
    let write = "printf project-write > made.txt && cat made.txt";
    let output = approved(&s, &chat, &script, "write", write).await?;
    assert!(output.contains("credential_reads_denied"), "{output}");
    assert_eq!(
        std::fs::read_to_string(project.join("made.txt"))?,
        "project-write"
    );
    eprintln!("PERM-SECRETS macOS: denied=4 guard_refused=1 project_write=complete");
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The delivered output of one approved command; the card shows it exactly.
async fn approved(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    id: &str,
    command: &str,
) -> Result<String, HarnessError> {
    let prompt = format!("Run the {id} step.");
    script
        .rounds
        .lock()
        .unwrap()
        .insert(prompt.clone(), vec![mutation(id, command)]);
    let turn = s.gw.say_turn(chat, &prompt).await?;
    let state =
        s.gw.wait_turn(
            chat,
            &turn,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    if state["state"] == "waiting_for_form" {
        let cards = s.gw.approval_requests(chat).await?;
        assert_eq!(
            cards[0]["approval"]["operation"]["command"], command,
            "{cards:?}"
        );
        assert_ne!(cards[0]["reason"], REASON, "{cards:?}");
        approve(s, chat, "allow").await?;
    }
    delivered(s, chat, &turn).await?;
    Ok(outputs(s, chat, &turn, script, &prompt).await?.join("\n"))
}

#[tokio::test]
async fn hosts_without_secret_denial_ask_with_the_unsandboxed_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("PERM-UNSANDBOXED")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_TEST_SECRET_READ_DENIAL", "unavailable");
    let folder = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(&project)?;
    // `$x` is empty in both POSIX sh and PowerShell, and unresolvable lexically.
    let first = r#"echo one > "one$x.txt""#;
    let id = unsandboxed_card(&s, &chat, &script, "Write the first note.", first).await?;
    assert!(!project.join("one.txt").exists(), "ran before the approval");
    decide(&s, &chat, "allow", "conversation").await?;
    delivered(&s, &chat, &id).await?;
    assert!(
        project.join("one.txt").exists(),
        "did not run after the approval"
    );
    // The conversation permission just granted does not cover the next one.
    let second = r#"echo two > "two$x.txt""#;
    let id = unsandboxed_card(&s, &chat, &script, "Write the second note.", second).await?;
    decide(&s, &chat, "deny", "once").await?;
    delivered(&s, &chat, &id).await?;
    assert!(!project.join("two.txt").exists());
    eprintln!("PERM-UNSANDBOXED: asked=2 ran_after_allow=true standing_permission=ignored");
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The paused turn whose one card names `command` and the unsandboxed reason.
async fn unsandboxed_card(
    s: &Scenario,
    chat: &str,
    script: &Arc<Script>,
    prompt: &str,
    command: &str,
) -> Result<String, HarnessError> {
    script
        .rounds
        .lock()
        .unwrap()
        .insert(prompt.into(), vec![mutation("unsandboxed", command)]);
    let id = paused(s, chat, prompt).await?;
    let cards = s.gw.approval_requests(chat).await?;
    assert_eq!(cards.len(), 1, "{cards:?}");
    assert_eq!(cards[0]["reason"], REASON, "{cards:?}");
    assert_eq!(
        cards[0]["approval"]["operation"]["command"], command,
        "{cards:?}"
    );
    Ok(id)
}

async fn decide(s: &Scenario, chat: &str, action: &str, scope: &str) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests(chat).await? {
        let reference = card["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
                json!({"scope":scope}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    }
    Ok(())
}
