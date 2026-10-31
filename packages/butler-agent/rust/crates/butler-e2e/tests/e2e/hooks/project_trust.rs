//! Hooks from a project folder: nothing runs before the user answers a card about
//! their exact content, and what runs is what the card showed.
use super::*;
use std::path::PathBuf;

#[path = "project_trust/added_text.rs"]
mod added_text;
#[path = "project_trust/boundary.rs"]
mod boundary;
#[path = "project_trust/modes.rs"]
mod modes;
#[path = "project_trust/off.rs"]
mod off;
#[path = "project_trust/sandbox.rs"]
mod sandbox;
#[path = "project_trust/slots.rs"]
mod slots;

pub(super) struct Project {
    pub(super) root: PathBuf,
    id: String,
    /// The first chat, created before any hook file exists.
    pub(super) chat: String,
    observe: Vec<String>,
    print: Vec<String>,
    home: PathBuf,
}

/// A started agent with a project folder; the stub reads a file, then answers.
pub(super) async fn start(name: &str) -> Result<(Scenario, Project), HarnessError> {
    start_with(Setup::new(name)?.stub_cassette(Cassette::load("TOOL-01")?)).await
}

pub(super) async fn start_with(setup: Setup) -> Result<(Scenario, Project), HarnessError> {
    let observe = fixture(&setup, "observe");
    let print = fixture(&setup, "print");
    let mut s = setup.start().await?;
    let parent = s.sandbox.root.join("projects");
    fs::create_dir_all(&parent)?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    let projects = s.gw.get("/projects").await?;
    let id = projects.data()["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["display_name"] == "작업 Project")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let root = parent.join("작업 Project");
    fs::write(root.join("hook-input.txt"), "Exact tool content")?;
    s.provider()?.set_chat_responder(stub::read_input);
    let home = s.sandbox.home.clone();
    Ok((
        s,
        Project {
            root,
            id,
            chat,
            observe,
            print,
            home,
        },
    ))
}

impl Project {
    /// A hook appending its payload to `out`, a file under the sandbox home.
    pub(super) fn observer(&self, id: &str, event: &str, out: &str) -> Value {
        json!({"id":id,"event":event,"type":"command","args":self.observe,
            "env":{"HOOK_OUTPUT":self.home.join(out)},"timeout_ms":3000})
    }
    /// A hook that prints `text` to stdout.
    pub(super) fn printing(&self, id: &str, event: &str, text: &str) -> Value {
        json!({"id":id,"event":event,"type":"command","args":self.print,
            "env":{"HOOK_TEXT":text},"timeout_ms":10000})
    }
    pub(super) fn write(&self, hooks: &[Value]) -> Result<(), HarnessError> {
        fs::create_dir_all(self.root.join(".butler"))?;
        fs::write(
            self.root.join(".butler/hooks.json"),
            json!({"version":1,"hooks":hooks}).to_string(),
        )?;
        Ok(())
    }
    pub(super) fn ran(&self, out: &str) -> Vec<Value> {
        let path = self.home.join(out);
        if !path.exists() {
            return Vec::new();
        }
        payloads_at(&path)
    }
    pub(super) fn events(&self, out: &str) -> Vec<String> {
        self.ran(out)
            .iter()
            .map(|run| run["hook_event_name"].as_str().unwrap().to_owned())
            .collect()
    }
    pub(super) async fn new_chat(&self, s: &Scenario) -> Result<String, HarnessError> {
        let reply = s.gw.post("/sessions", json!({"kind":"project","project_id":self.id,"workspace_mode":"local","title":"Second"})).await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
        Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
    }
}

fn payloads_at(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .trim_start_matches('\u{feff}')
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// The card this chat waits on.
pub(super) async fn card(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(card) = s.gw.approval_requests(chat).await?.into_iter().next() {
            return Ok(card);
        }
        let turns = s.gw.turns(chat).await?;
        assert!(
            Instant::now() < deadline,
            "no card: {turns:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) async fn answer(
    s: &Scenario,
    chat: &str,
    card: &Value,
    action: &str,
) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    Ok(())
}

pub(super) async fn delivered(s: &Scenario, chat: &str, turn: &str) -> Result<(), HarnessError> {
    let done =
        s.gw.wait_terminal(chat, turn, Duration::from_secs(30))
            .await?;
    assert_eq!(done["state"], "delivered", "{done}\n{}", s.agent.logs());
    Ok(())
}

/// A whole turn that must not show a card.
pub(super) async fn quiet_turn(s: &Scenario, chat: &str, text: &str) -> Result<(), HarnessError> {
    let turn = s.gw.say_turn(chat, text).await?;
    delivered(s, chat, &turn).await?;
    assert_eq!(s.gw.approval_requests(chat).await?, Vec::<Value>::new());
    Ok(())
}

pub(super) fn lines(card: &Value) -> Vec<Value> {
    assert_eq!(card["approval"]["action_kind"], "project_hooks", "{card}");
    card["approval"]["project_hooks"]["hooks"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn project_hooks_run_nothing_until_allowed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-FIRST").await?;
    let all: Vec<Value> = [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
    ]
    .into_iter()
    .map(|event| project.observer(event, event, "ran.jsonl"))
    .collect();
    project.write(&all)?;
    let chat = project.new_chat(&s).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 0, "SessionStart ran early");

    let turn = s.gw.say_turn(&chat, "Check the project.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["risk"], "high");
    assert_eq!(asked["approval"]["targets"][0]["path"], "작업 Project");
    assert_eq!(asked["approval"]["operation"]["allow_conversation"], false);
    assert_eq!(asked["approval"]["project_hooks"]["changed"], false);
    // The full path, so two folders with one name cannot pass for each other.
    let location = asked["approval"]["project_hooks"]["file"].as_str().unwrap();
    assert!(
        location.ends_with("작업 Project/.butler/hooks.json") && Path::new(location).is_absolute(),
        "{location}"
    );
    let shown = lines(&asked);
    assert_eq!(shown.len(), 5, "{shown:?}");
    assert_eq!(shown[2]["event"], "PreToolUse");
    let command = shown[2]["command"].as_str().unwrap();
    assert!(
        command.contains("HOOK_OUTPUT=") && command.contains("observe"),
        "{command}"
    );
    assert!(
        shown.iter().all(|line| line.get("change").is_none()),
        "{shown:?}"
    );
    // Parked before the first round: neither the model nor a hook has run.
    assert!(
        s.provider()?
            .requests()
            .iter()
            .all(|r| r.get("tools").is_none()),
        "a model round ran before the answer"
    );
    assert_eq!(project.ran("ran.jsonl").len(), 0);

    // The card answers for this content only: no wider scope and no alternative.
    let reference = asked["request_ref"].as_str().unwrap();
    for (action, body) in [
        ("allow", json!({"scope":"conversation"})),
        ("modify", json!({"instruction":"Run something else"})),
    ] {
        let refused =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
                body,
            )
            .await?;
        assert_ne!(refused.status, 202, "{}", refused.text);
    }
    assert_eq!(project.ran("ran.jsonl").len(), 0);

    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    // The prompt was already admitted, so UserPromptSubmit starts with the next one.
    assert_eq!(
        project.events("ran.jsonl"),
        ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]
    );
    let run = &project.ran("ran.jsonl")[0];
    assert_eq!(run["hook"]["scope"], "project");
    assert_eq!(run["hook"]["id"], "project:SessionStart");
    let requests = s.provider()?.requests();
    assert!(
        requests
            .last()
            .unwrap()
            .to_string()
            .contains("Check the project.")
    );

    // Same content, later turn and later chat: never asked again.
    quiet_turn(&s, &chat, "Again.").await?;
    assert_eq!(
        project.events("ran.jsonl")[4..],
        ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
    );
    let other = project.new_chat(&s).await?;
    assert_eq!(
        project.events("ran.jsonl").len(),
        9,
        "SessionStart of a trusted chat"
    );
    quiet_turn(&s, &other, "Another chat.").await?;
    // The record is the user's, in a credential root; the project folder holds nothing new.
    assert!(s.sandbox.data.join("auth/project-hook-trust.json").exists());
    assert_eq!(fs::read_dir(project.root.join(".butler"))?.count(), 1);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_changed_content_asks_again_and_marks_lines() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-CHANGED").await?;
    let chat = project.chat.clone();
    let stays = project.observer("stays", "Stop", "stays.jsonl");
    let first = [
        stays.clone(),
        project.observer("guard", "PreToolUse", "old.jsonl"),
        project.observer("gone", "PostToolUse", "gone.jsonl"),
    ];
    project.write(&first)?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("old.jsonl").len(), 1);

    // Only the formatting moves: the same hooks, so nobody is asked.
    let same = serde_json::to_string_pretty(&json!({"version":1,"hooks":first}))?;
    fs::write(project.root.join(".butler/hooks.json"), same)?;
    quiet_turn(&s, &chat, "Reformatted.").await?;

    // Neither a display name nor a disabled hook changes what runs.
    let mut named = first.to_vec();
    named[0]["name"] = json!("A display name");
    let mut idle = project.observer("idle", "Stop", "idle.jsonl");
    idle["enabled"] = json!(false);
    named.push(idle);
    project.write(&named)?;
    quiet_turn(&s, &chat, "Renamed.").await?;
    assert_eq!(project.ran("idle.jsonl").len(), 0);

    project.write(&[
        stays,
        project.observer("guard", "PreToolUse", "new.jsonl"),
        project.observer("added", "PostToolUse", "added.jsonl"),
    ])?;
    let (old, stayed) = (
        project.ran("old.jsonl").len(),
        project.ran("stays.jsonl").len(),
    );
    let gone = project.ran("gone.jsonl").len();
    let turn = s.gw.say_turn(&chat, "After the change.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["project_hooks"]["changed"], true);
    let shown = lines(&asked);
    let change = |id: &str| shown.iter().find(|line| line["id"] == id).unwrap()["change"].clone();
    assert_eq!(change("stays"), Value::Null);
    assert_eq!(change("guard"), "changed");
    assert_eq!(change("added"), "added");
    assert_eq!(change("gone"), "removed");
    assert!(shown[1]["command"].as_str().unwrap().contains("new.jsonl"));
    // While it waits, neither the old nor the new content runs.
    assert_eq!(project.ran("old.jsonl").len(), old);
    assert_eq!(project.ran("new.jsonl").len(), 0);
    assert_eq!(project.ran("stays.jsonl").len(), stayed);

    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("old.jsonl").len(), old);
    assert_eq!(project.ran("new.jsonl").len(), 1);
    assert_eq!(project.ran("added.jsonl").len(), 1);
    assert_eq!(
        project.ran("gone.jsonl").len(),
        gone,
        "removed hook ran again"
    );
    s.finish().await
}

#[tokio::test]
async fn project_hooks_denial_is_remembered_and_runs_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, project) = start("HOOK-PROJECT-DENY").await?;
    let chat = project.chat.clone();
    let hook = project.observer("guard", "PreToolUse", "denied.jsonl");
    project.write(&[hook])?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    card(&s, &chat).await?;
    // The card, and the follow-up queued behind it, outlive a restart.
    let queued = s.gw.say(&chat, "Queued follow-up.").await?;
    s.restart().await?;
    answer(&s, &chat, &card(&s, &chat).await?, "deny").await?;
    // A denied hook is not a denied turn: the work goes on without it.
    delivered(&s, &chat, &turn).await?;
    let followup = s.gw.accepted_turn(&queued).await?;
    delivered(&s, &chat, &followup).await?;
    let asked_model = s.provider()?.requests();
    assert!(asked_model.iter().any(|r| r.to_string().contains("First.")));
    assert_eq!(project.ran("denied.jsonl").len(), 0);

    quiet_turn(&s, &chat, "Second.").await?;
    let other = project.new_chat(&s).await?;
    quiet_turn(&s, &other, "Another chat.").await?;
    s.restart().await?;
    quiet_turn(&s, &chat, "After a restart.").await?;
    assert_eq!(project.ran("denied.jsonl").len(), 0);

    // Other content is another question, and nothing was ever allowed to compare with.
    project.write(&[project.observer("guard", "PreToolUse", "second.jsonl")])?;
    let turn = s.gw.say_turn(&chat, "Changed.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["project_hooks"]["changed"], false);
    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("second.jsonl").len(), 1);
    assert_eq!(project.ran("denied.jsonl").len(), 0);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_card_shows_what_affects_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-LINES").await?;
    let chat = project.chat.clone();
    let hidden = "a\u{61c}b\u{34f}c\u{115f}d\u{3164}e\u{180e}f\u{fe0f}g\u{e0041}h\u{1d173}i\u{2800}j\u{fff9}k\u{a0}l\u{3000}m  n\to";
    let mut guard = hook("guard", "PreToolUse", hidden);
    guard["failClosed"] = json!(true);
    guard["timeout_ms"] = json!(5000);
    guard["match"] = json!({"tools":["read_file"]});
    let background = json!({"id":"background","event":"PostToolUse","type":"command","command":"true","async":true});
    let plain = project.observer("plain", "Stop", "plain.jsonl");
    project.write(&[guard, background, plain])?;
    let turn = s.gw.say_turn(&chat, "Check.").await?;
    let asked = card(&s, &chat).await?;
    let shown = lines(&asked);
    assert_eq!(
        shown[0]["command"],
        "a\\u{61c}b\\u{34f}c\\u{115f}d\\u{3164}e\\u{180e}f\\u{fe0f}g\\u{e0041}h\\u{1d173}i\\u{2800}j\\u{fff9}k\\u{a0}l\\u{3000}m \\u{20}n\\to"
    );
    assert_eq!(shown[0]["fail_closed"], true);
    assert_eq!(shown[0]["timeout_ms"], 5000);
    assert_eq!(shown[1]["asynchronous"], true);
    assert_eq!(shown[1].get("timeout_ms"), None, "the default is not news");
    assert_eq!(shown[2].get("fail_closed"), None);
    answer(&s, &chat, &asked, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    s.finish().await
}
