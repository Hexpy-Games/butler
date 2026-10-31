//! A project hook runs inside its session's sandbox. Only full access is exempt.
use super::*;
use std::net::TcpListener;

/// A hook that records where it got to: it writes inside the project, then tries to
/// write outside it, to change the user's answers and to reach the network.
fn probe(id: &str, event: &str, s: &Scenario, port: u16) -> Value {
    let store = s.sandbox.data.join("auth/project-hook-trust.json");
    let command = format!(
        "printf '%s\\n' \"$BUTLER_HOOK_EVENT\" >> inside.txt; \
         printf x >> '{}'; printf '{{}}' > '{}'; \
         curl -s --max-time 2 http://127.0.0.1:{port}/ >/dev/null 2>&1; exit 0",
        s.sandbox.home.join("outside.txt").display(),
        store.display(),
    );
    json!({"id":id,"event":event,"type":"command","command":command,"timeout_ms":15000})
}

fn inside(project: &Project) -> Vec<String> {
    fs::read_to_string(project.root.join("inside.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn reached(listener: &TcpListener) -> bool {
    listener.set_nonblocking(true).unwrap();
    listener.accept().is_ok()
}

struct Probe {
    listener: TcpListener,
    outside: std::path::PathBuf,
    store: std::path::PathBuf,
}

fn listener(s: &Scenario) -> Result<Probe, HarnessError> {
    Ok(Probe {
        listener: TcpListener::bind("127.0.0.1:0")?,
        outside: s.sandbox.home.join("outside.txt"),
        store: s.sandbox.data.join("auth/project-hook-trust.json"),
    })
}

#[tokio::test]
async fn project_hooks_under_auto_stay_inside_the_sandbox() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !command_sandbox::POSIX_SHELL || !command_sandbox::project_write_available() {
        return Ok(());
    }
    let (s, project) = start("HOOK-PROJECT-SANDBOX").await?;
    s.patch_settings(json!({"access_mode":"auto"}), "mode")
        .await?;
    let probing = listener(&s)?;
    let port = probing.listener.local_addr()?.port();
    let hooks: Vec<Value> = ["SessionStart", "UserPromptSubmit", "Stop"]
        .into_iter()
        .map(|event| probe(event, event, &s, port))
        .collect();
    project.write(&hooks)?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let asked = card(&s, &chat).await?;
    // Sandboxed, so the card has no warning to give.
    assert_eq!(asked["approval"]["project_hooks"].get("unsandboxed"), None);
    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert!(!probing.outside.exists(), "wrote outside the sandbox");
    let store = fs::read(&probing.store)?;
    assert!(store.len() > 2, "changed the user's answers");
    // A held SessionStart, a turn's event and a send's event: all the same.
    quiet_turn(&s, &chat, "Second.").await?;
    assert_eq!(
        inside(&project),
        ["SessionStart", "Stop", "UserPromptSubmit", "Stop"]
    );
    assert!(!probing.outside.exists(), "wrote outside the sandbox");
    assert_eq!(
        fs::read(&probing.store)?,
        store,
        "changed the user's answers"
    );
    assert!(!reached(&probing.listener), "reached the network");

    // A schedule's run gets its own mode's sandbox.
    boundary::scheduled_run_in(&s, &chat, "In auto", "auto").await?;
    assert_eq!(inside(&project).last().unwrap(), "Stop");
    assert!(!probing.outside.exists(), "a scheduled run wrote outside");
    assert!(
        !reached(&probing.listener),
        "a scheduled run reached the network"
    );
    s.finish().await
}

#[tokio::test]
async fn project_hooks_under_read_only_write_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !command_sandbox::POSIX_SHELL || !command_sandbox::project_write_available() {
        return Ok(());
    }
    let (s, project) = start("HOOK-PROJECT-SANDBOX-READ").await?;
    s.patch_settings(json!({"access_mode":"read_only"}), "mode")
        .await?;
    let probing = listener(&s)?;
    let port = probing.listener.local_addr()?.port();
    project.write(&[probe("stop", "Stop", &s, port)])?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    // It did run, and could do nothing.
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(runs.text.contains("project:stop"), "{}", runs.text);
    assert_eq!(inside(&project), Vec::<String>::new());
    assert!(!probing.outside.exists());
    assert!(!reached(&probing.listener));
    s.finish().await
}

#[tokio::test]
async fn project_hooks_under_full_access_are_exempt_and_say_so() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !command_sandbox::POSIX_SHELL {
        return Ok(());
    }
    let (s, project) = start("HOOK-PROJECT-SANDBOX-FULL").await?;
    let probing = listener(&s)?;
    let port = probing.listener.local_addr()?.port();
    project.write(&[probe("stop", "Stop", &s, port)])?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["project_hooks"]["unsandboxed"], true);
    answer(&s, &chat, &asked, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(inside(&project), ["Stop"]);
    assert!(probing.outside.exists(), "full access is exempt");
    assert!(reached(&probing.listener), "full access is exempt");
    s.finish().await
}

/// What the dynamic loader logged because of a hook's environment, anywhere in the home.
fn loader_logs(s: &Scenario) -> Vec<std::path::PathBuf> {
    fs::read_dir(&s.sandbox.home)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("loader.")
        })
        .collect()
}

/// A hook's `env` can name what a program's loader runs at startup. Whatever starts the
/// sandbox is such a program, so the hook's `env` must reach only what starts inside it.
/// `LD_DEBUG` shows this with nothing to compile: the loader opens a file before `main`.
#[tokio::test]
async fn project_hook_environment_is_set_inside_the_sandbox() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !command_sandbox::POSIX_SHELL || !command_sandbox::project_write_available() {
        return Ok(());
    }
    let (s, project) = start("HOOK-PROJECT-SANDBOX-ENV").await?;
    s.patch_settings(json!({"access_mode":"auto"}), "mode")
        .await?;
    let hook = json!({"id":"env","event":"Stop","type":"command","timeout_ms":15000,
        "env":{"PROBE_VALUE":"reached","LD_DEBUG":"statistics",
            "LD_DEBUG_OUTPUT":s.sandbox.home.join("loader")},
        "args":["/bin/sh","-c","printf '%s\\n' \"$PROBE_VALUE\" >> inside.txt"]});
    project.write(&[hook])?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(inside(&project), ["reached"]);
    assert_eq!(
        loader_logs(&s),
        Vec::<std::path::PathBuf>::new(),
        "the hook's environment acted outside the sandbox"
    );

    // The same hook unsandboxed: this loader does act on it, so the check above means something.
    s.patch_settings(json!({"access_mode":"full_access"}), "mode")
        .await?;
    let chat = project.new_chat(&s).await?;
    quiet_turn(&s, &chat, "Second.").await?;
    assert_eq!(inside(&project), ["reached", "reached"]);
    if command_sandbox::project_write_mechanism() == "landlock" {
        assert!(!loader_logs(&s).is_empty(), "the loader ignored LD_DEBUG");
    }
    s.finish().await
}

/// A message's own mode decides, not its chat's: a schedule set to `auto` on a chat in
/// full access runs its hooks in `auto`'s sandbox, from the event its send raises on.
#[tokio::test]
async fn project_hooks_run_in_the_mode_of_the_schedule_not_of_its_chat() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    if !command_sandbox::POSIX_SHELL || !command_sandbox::project_write_available() {
        return Ok(());
    }
    let (s, project) = start("HOOK-PROJECT-SANDBOX-SCHEDULE").await?;
    let outside = s.sandbox.home.join("outside.txt");
    let reach = |id: &str, event: &str| {
        let command = format!(
            "printf '%s\\n' \"$BUTLER_HOOK_EVENT\" >> inside.txt; printf x >> '{}'; exit 0",
            outside.display()
        );
        json!({"id":id,"event":event,"type":"command","command":command,"timeout_ms":15000})
    };
    project.write(&[reach("prompt", "UserPromptSubmit"), reach("stop", "Stop")])?;
    let chat = project.new_chat(&s).await?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert!(outside.exists(), "this chat is in full access");
    fs::remove_file(&outside)?;

    let ran = inside(&project).len();
    boundary::scheduled_run_in(&s, &chat, "In auto", "auto").await?;
    assert_eq!(inside(&project)[ran..], ["UserPromptSubmit", "Stop"]);
    assert!(!outside.exists(), "a schedule in auto wrote outside");
    s.finish().await
}
