//! Retired core skills disappear across updates without deleting custom skills.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod stub;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::{Value, json};
use std::{fs, path::Path};

const RETIRED: [&str; 5] = [
    "butler-model",
    "project",
    "project-ledger",
    "butler-ship-feature",
    "save-feedback",
];
const CURRENT: [&str; 5] = [
    "persona",
    "restart",
    "save-instructions",
    "status",
    "wallpaper-authoring",
];

fn names(view: &Value) -> Vec<&str> {
    view["core"]
        .as_array()
        .unwrap()
        .iter()
        .map(|skill| skill["name"].as_str().unwrap())
        .collect()
}

fn old_resources(resources: &Path) -> Result<(), HarnessError> {
    let source = butler_e2e::e2e::binary::manifest_dir().join("fixtures/retired-core-skills");
    for folder in ["model", "project", "project-ledger", "ship-feature"] {
        let target = resources.join("skills").join(folder);
        fs::create_dir_all(&target)?;
        fs::copy(
            source.join(folder).join("SKILL.md.txt"),
            target.join("SKILL.md"),
        )?;
    }
    let target = resources.join("skills/save-feedback");
    fs::create_dir_all(&target)?;
    fs::write(
        target.join("SKILL.md"),
        "---\nname: save-feedback\ndescription: Retired feedback capture\n---\nRETIRED_FEEDBACK_BODY\n",
    )?;
    Ok(())
}

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut c = Cassette::load("TOOL-01")?;
    c.exchanges.clear();
    for (index, name) in RETIRED.iter().enumerate() {
        for prefix in ["Retired", "Custom"] {
            let prompt = format!("{prefix} {name}");
            let mut call = template.exchanges[0].clone();
            call.request.key.user_request = prompt.clone();
            call.response = stub::response(
                &json!({"type":"function_call", "id":format!("fc_skill_{prefix}_{index}"), "call_id":format!("call_skill_{prefix}_{index}"), "name":"load_skill", "status":"completed", "arguments":json!({"name":name}).to_string()}),
            );
            let mut answer = template.exchanges[1].clone();
            answer.request.key.user_request = prompt;
            answer.response = stub::response(
                &json!({"type":"message", "id":format!("msg_skill_{prefix}_{index}"), "role":"assistant", "status":"completed", "content":[{"type":"output_text", "text":"Checked.", "annotations":[]}]}),
            );
            c.exchanges.extend([call, answer]);
        }
    }
    Ok(c)
}

async fn load(
    s: &butler_e2e::e2e::scenario::Scenario,
    chat: &str,
    prompt: &str,
) -> Result<Value, HarnessError> {
    let before = s.provider()?.requests().len();
    let (_, turn) = s.turn(chat, prompt).await?;
    assert_eq!(
        turn["state"],
        "delivered",
        "{turn}; {:?}",
        s.provider()?.misses()
    );
    let requests = s.provider()?.requests();
    assert_eq!(requests.len() - before, 2);
    let outputs: Vec<_> = requests[before + 1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .collect();
    assert_eq!(outputs.len(), 1);
    Ok(serde_json::from_str(
        outputs[0]["output"].as_str().unwrap(),
    )?)
}

async fn new_chat(s: &butler_e2e::e2e::scenario::Scenario) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"general","title":"Skills cleanup"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn fresh_and_existing_core_catalog_preserves_custom_skills_and_installation()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for old in [false, true] {
        let setup = Setup::new("SKILLS-CLEANUP")?
            .stub_cassette(cassette()?)
            .replay_only();
        if old {
            old_resources(&setup.sandbox.resources)?;
        }
        let installation = setup.sandbox.installation_fingerprint()?;
        let mut s = setup.start().await?;
        let skills = s.gw.get("/skills").await?;
        assert_eq!(skills.status, 200);
        assert_eq!(names(skills.data()), CURRENT);
        let cli = s
            .agent
            .launch
            .command()
            .args(["skills", "list", "--json"])
            .output()?;
        assert!(
            cli.status.success(),
            "{}",
            String::from_utf8_lossy(&cli.stderr)
        );
        let cli: Value = serde_json::from_slice(&cli.stdout)?;
        assert_eq!(names(&cli["data"]), CURRENT);
        for name in RETIRED {
            let chat = new_chat(&s).await?;
            let result = load(&s, &chat, &format!("Retired {name}")).await?;
            assert!(result.to_string().contains("skill_not_found"), "{result}");
            let first = &s.provider()?.requests()[s.provider()?.requests().len() - 2];
            let instructions = first["instructions"].as_str().unwrap();
            assert!(
                !instructions.contains(&format!("{name}:")),
                "retired skill in prompt"
            );
        }
        for name in RETIRED {
            let path = s.sandbox.data.join("skills/default").join(name);
            fs::create_dir_all(&path)?;
            fs::write(
                path.join("SKILL.md"),
                format!(
                    "---\nname: {name}\ndescription: User-authored skill\n---\nCUSTOM_BODY_{name}\n"
                ),
            )?;
        }
        s.agent.terminate().await?;
        s.gw = s.agent.start_again().await?;
        let skills = s.gw.get("/skills").await?.data().clone();
        assert_eq!(names(&skills), CURRENT);
        assert_eq!(skills["user"].as_array().unwrap().len(), 5);
        for name in RETIRED {
            let chat = new_chat(&s).await?;
            let result = load(&s, &chat, &format!("Custom {name}")).await?;
            assert!(
                result.to_string().contains(&format!("CUSTOM_BODY_{name}")),
                "{result}"
            );
            assert_eq!(
                fs::read_to_string(
                    s.sandbox
                        .data
                        .join("skills/default")
                        .join(name)
                        .join("SKILL.md")
                )?,
                format!(
                    "---\nname: {name}\ndescription: User-authored skill\n---\nCUSTOM_BODY_{name}\n"
                )
            );
        }
        let created =
            s.gw.post(
                "/projects",
                json!({"source":"scratch","display_name":"Custom skills"}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
        let ledger = s
            .sandbox
            .data
            .join("project-ledger/projects")
            .join(&project);
        fs::create_dir_all(&ledger)?;
        fs::write(
            ledger.join("project.json"),
            serde_json::to_vec(
                &json!({"schema":"project-ledger.project.v1","id":project,"name":"Custom skills","status":"active","createdAt":"2026-10-03T00:00:00Z","updatedAt":"2026-10-03T00:00:00Z"}),
            )?,
        )?;
        fs::write(ledger.join("ledger.jsonl"), b"")?;
        let path = s
            .sandbox
            .data
            .join("skills/projects")
            .join(&project)
            .join("project");
        fs::create_dir_all(&path)?;
        let body =
            "---\nname: project\ndescription: Project-authored skill\n---\nPROJECT_CUSTOM_BODY\n";
        fs::write(path.join("SKILL.md"), body)?;
        let session =
            s.gw.post(
                "/sessions",
                json!({"kind":"project","title":"Custom","project_id":project}),
            )
            .await?;
        assert_eq!(session.status, 201, "{}", session.text);
        let chat = session.data()["session"]["id"].as_str().unwrap().to_owned();
        let result = load(&s, &chat, "Custom project").await?;
        assert!(
            result.to_string().contains("PROJECT_CUSTOM_BODY"),
            "{result}"
        );
        assert!(
            !result.to_string().contains("CUSTOM_BODY_project"),
            "{result}"
        );
        assert_eq!(fs::read_to_string(path.join("SKILL.md"))?, body);
        assert_eq!(s.sandbox.installation_fingerprint()?, installation);
        s.finish().await?;
    }
    Ok(())
}
