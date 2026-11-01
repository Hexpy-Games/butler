//! A session's project hooks are the ones of the folder it works in.
use super::*;

/// Both reviews read the folder the session works in, and its hooks run there.
#[tokio::test]
async fn project_hooks_follow_the_session_into_its_worktree() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, chat, project, script, server) = project(Access::FullAccess, "FOLDER-HOOKS").await?;
    let worktree = project.parent().unwrap().join("wt-hooks");
    const MAKE: &str = "Make a worktree for hooks.";
    script.set(
        MAKE,
        vec![command(
            "add",
            "git worktree add ../wt-hooks -b hooks",
            "mutation",
        )],
    );
    delivered(&s, &chat, MAKE).await?;
    let worktree = canonical(&worktree);
    let hook = |out: &str| {
        let out = s.sandbox.home.join(out);
        let command = if butler_platform::command_sandbox::POSIX_SHELL {
            format!("pwd >> '{}'", out.display())
        } else {
            format!("cd >> \"{}\"", out.display())
        };
        json!({"version":1,"hooks":[
            {"id":"stop","event":"Stop","type":"command","command":command,"timeout_ms":3000},
            {"id":"prompt","event":"UserPromptSubmit","type":"command","command":command,"timeout_ms":3000},
        ]})
        .to_string()
    };
    for (folder, out) in [(&project, "root.txt"), (&worktree, "worktree.txt")] {
        std::fs::create_dir_all(folder.join(".butler"))?;
        std::fs::write(folder.join(".butler/hooks.json"), hook(out))?;
    }
    const ASK: &str = "Say something.";
    script.set(ASK, vec![]);
    let turn = s.gw.say_turn(&chat, ASK).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let asked = loop {
        if let Some(card) = s.gw.approval_requests(&chat).await?.into_iter().next() {
            break card;
        }
        assert!(Instant::now() < deadline, "no card");
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let folder = asked["approval"]["project_hooks"]["folder"]
        .as_str()
        .unwrap();
    assert!(folder.contains("wt-hooks"), "{folder}");
    let reference = asked["request_ref"].as_str().unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id={chat}"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{}", allowed.text);
    let done =
        s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    const AGAIN: &str = "Say something else.";
    script.set(AGAIN, vec![]);
    delivered(&s, &chat, AGAIN).await?;
    let ran = std::fs::read_to_string(s.sandbox.home.join("worktree.txt"))?;
    let folders: Vec<&str> = ran.lines().collect();
    assert_eq!(
        folders.len(),
        3,
        "Stop, then UserPromptSubmit and Stop: {ran}"
    );
    for folder in folders {
        assert_eq!(canonical(Path::new(folder.trim())), worktree);
    }
    assert!(!s.sandbox.home.join("root.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}
