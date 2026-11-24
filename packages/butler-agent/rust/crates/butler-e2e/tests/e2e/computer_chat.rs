//! Chat-driven remote computer registration through the question card.
#![allow(clippy::unwrap_used, reason = "test assertions")]

use super::{
    ask_user::{pending, reply},
    setup_local_models::use_local_model,
    tools_direct_args::call,
};
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LocalCapabilities},
    fixtures,
    gateway::{tool_rows, turn_state},
    scenario::{Fixture, Scenario, Setup},
    security::AdminClient,
    sshd::{TestSshd, user_ssh_config},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

const ALIAS: &str = "studio-ssh";
const ADD: &str = "Add my Studio computer.";
const DONE: &str = "Finished.";

fn bridge(id: &str, tool: &str, args: &Value) -> Value {
    call(
        id,
        "tool_call",
        &json!({"id":format!("native:{tool}"),"arguments":args}),
    )
}

fn add_args() -> Value {
    json!({"name":"Studio","address":ALIAS,"folder":"~","model":"none"})
}

fn add_questions() -> Value {
    let proposed = |field, title, label| {
        json!({
            "id":format!("computer_add.{field}"),"eyebrow":"컴퓨터","title":title,"kind":"single",
            "allow_custom":true,"options":[{"id":"proposed","label":label,"recommended":true}]
        })
    };
    json!({"questions":[
        proposed("name","컴퓨터 이름","Studio"),
        proposed("address","SSH 주소 (~/.ssh/config 별칭 사용 가능)", ALIAS),
        proposed("folder","작업 폴더","~"),
        {"id":"computer_add.model","eyebrow":"컴퓨터","title":"그 컴퓨터에서 쓸 모델","kind":"single",
            "allow_custom":false,"options":[
                {"id":"model:follow","label":"이 기기와 같게"},
                {"id":"model:chatgpt","label":"ChatGPT"},
                {"id":"model:none","label":"설정 안 함","recommended":true}
            ]}
    ]})
}

fn ssh_fixture(setup: &Setup) -> Result<(TestSshd, String), HarnessError> {
    let home = &setup.sandbox.home;
    let config = user_ssh_config(home)?;
    let key = home.join(".ssh/id_ed25519");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()?;
    assert!(generated.status.success());
    let sshd = TestSshd::start(&home.join("sshd"), &key.with_extension("pub"), Some(home))?;
    writeln!(
        fs::OpenOptions::new().append(true).open(&config)?,
        "\nHost {ALIAS}\n  HostName 127.0.0.1\n  Port {}\n  IdentityFile {}\n  IdentitiesOnly yes",
        sshd.port,
        key.display()
    )?;
    let host = fs::read_to_string(sshd.host_key.with_extension("pub"))?;
    let host_key = host
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    fs::write(
        home.join(".ssh/known_hosts"),
        format!("[127.0.0.1]:{} {host_key}\n", sshd.port),
    )?;
    Ok((sshd, config.to_string_lossy().into_owned()))
}

async fn start(
    setup: Setup,
    calls: Vec<Value>,
) -> Result<(FakeServer, Scenario, AdminClient), HarnessError> {
    let script = calls
        .into_iter()
        .flat_map(|call| [call, json!({"role":"assistant","content":DONE})])
        .collect();
    let server = FakeServer::local_models(ChatBehavior {
        script,
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let closed = format!("http://127.0.0.1:{}", butler_e2e::e2e::agent::free_port()?);
    let setup = setup
        .fixture(Fixture::Empty)
        .env("BUTLER_OLLAMA_BASE_URL", server.base_url.clone())
        .env("BUTLER_LM_STUDIO_BASE_URL", &closed)
        .env("BUTLER_REMOTE_RELEASE_BASE", &closed);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let s = setup.start().await?;
    use_local_model(&s, &server.base_url).await?;
    let language =
        s.gw.patch("/personalization", json!({"response_language":"ko"}))
            .await?;
    assert_eq!(language.status, 200, "{}", language.text);
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    Ok((server, s, api))
}

async fn result(s: &Scenario, turn: &str) -> Result<Value, HarnessError> {
    let done =
        s.gw.wait_terminal("general", turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    let rows = tool_rows(&s.gw.messages("general").await?, turn);
    let row = rows
        .iter()
        .rev()
        .find(|row| {
            matches!(row["state"].as_str(), Some("delivered" | "failed"))
                && row["tool_result_id"].is_string()
        })
        .unwrap();
    Ok(serde_json::from_str(
        &s.gw.operation_output(turn, row).await?,
    )?)
}

async fn listed(api: &AdminClient) -> Result<Value, HarnessError> {
    let response = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(response.status, 200, "{response:?}");
    Ok(response.data()["computers"].clone())
}

#[tokio::test]
async fn chat_add_applies_the_answered_values() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-CHAT-ADD")?;
    let (_sshd, config) = ssh_fixture(&setup)?;
    let (_server, s, api) = start(
        setup.env(butler_platform::remote_ssh::CONFIG_FIXTURE, config),
        vec![bridge("add", "computer_add", &add_args())],
    )
    .await?;
    let turn = s.gw.say_turn("general", ADD).await?;
    let card = pending(&s, &turn, add_questions()).await?;
    assert_eq!(listed(&api).await?, json!([]));
    reply(
        &s,
        &card,
        json!({"status":"answered","answers":[
            {"id":"computer_add.name","selected":[],"custom":"My Studio"},
            {"id":"computer_add.address","selected":["proposed"],"custom":null},
            {"id":"computer_add.folder","selected":["proposed"],"custom":null},
            {"id":"computer_add.model","selected":["model:none"],"custom":null}
        ]}),
    )
    .await?;
    let output = result(&s, &turn).await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(
        output["start_error"]["code"], "release_not_found",
        "{output}"
    );
    let computers = listed(&api).await?;
    assert_eq!(computers[0]["name"], "My Studio");
    assert_eq!(computers[0]["address"], ALIAS);
    s.finish().await
}

#[tokio::test]
async fn chat_add_skip_and_later_change_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (_server, s, api) = start(
        Setup::new("COMPUTER-CHAT-SKIP")?,
        vec![
            bridge("skip", "computer_add", &add_args()),
            bridge("defer", "computer_add", &add_args()),
        ],
    )
    .await?;
    let turn = s.gw.say_turn("general", ADD).await?;
    let card = pending(&s, &turn, add_questions()).await?;
    let answers: Vec<_> = ["name","address","folder","model"].map(|field|
        json!({"id":format!("computer_add.{field}"),"selected":[],"custom":null,"skipped":true})).into();
    reply(&s, &card, json!({"status":"answered","answers":answers})).await?;
    assert_eq!(result(&s, &turn).await?["cancelled"], true);
    let turn =
        s.gw.say_turn("general", "Ask again about adding my Studio computer.")
            .await?;
    let card = pending(&s, &turn, add_questions()).await?;
    reply(&s, &card, json!({"status":"deferred"})).await?;
    let output = result(&s, &turn).await?;
    assert_eq!(output["deferred"], true, "{output}");
    assert_eq!(output["applied"], false, "{output}");
    assert_eq!(listed(&api).await?, json!([]));
    s.finish().await
}

#[tokio::test]
async fn chat_edit_and_remove() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-CHAT-EDIT-REMOVE")?;
    let (_sshd, config) = ssh_fixture(&setup)?;
    let folder = setup.sandbox.home.join("projects");
    fs::create_dir(&folder)?;
    let (_server, s, api) = start(
        setup.env(butler_platform::remote_ssh::CONFIG_FIXTURE, config),
        vec![
            bridge(
                "edit",
                "computer_edit",
                &json!({"computer":"studio","folder":folder}),
            ),
            bridge("remove", "computer_remove", &json!({"computer":"Studio"})),
        ],
    )
    .await?;
    let added = api
        .send(
            Method::POST,
            "/computers",
            Some(json!({
                "name":"Studio","address":ALIAS,"folder":"~","model_source":"none"
            })),
            &[],
        )
        .await?;
    assert_eq!(added.status, 201, "{added:?}");
    let id = added.data()["computer"]["id"].as_str().unwrap();
    let turn =
        s.gw.say_turn("general", "Change Studio's work folder.")
            .await?;
    let field = format!("computer_edit:{id}.folder");
    let card = pending(&s, &turn, json!({"questions":[{
        "id":field,"eyebrow":"컴퓨터","title":"Studio의 작업 폴더","kind":"single","allow_custom":true,
        "options":[{"id":"proposed","label":folder,"recommended":true}]
    }]})).await?;
    reply(
        &s,
        &card,
        json!({"status":"answered","answers":[{"id":field,"selected":["proposed"],"custom":null}]}),
    )
    .await?;
    assert_eq!(
        result(&s, &turn).await?["computer"]["folder"],
        json!(folder)
    );
    assert_eq!(listed(&api).await?[0]["folder"], json!(folder));
    let turn =
        s.gw.say_turn("general", "Remove the Studio computer.")
            .await?;
    let field = format!("computer_remove:{id}.confirm");
    let card = pending(&s, &turn, json!({"questions":[{
        "id":field,"eyebrow":"컴퓨터","title":"Studio을 삭제할까요? 그 컴퓨터에 올린 버틀러와 모델 설정을 지웁니다. 대화 기록은 남습니다.",
        "kind":"single","allow_custom":false,"options":[
            {"id":"remove:keep","label":"삭제"},
            {"id":"remove:forget","label":"삭제하고 이 컴퓨터 대화에서 나온 기억도 지우기"}
        ]
    }]})).await?;
    reply(&s, &card, json!({"status":"answered","answers":[{"id":field,"selected":["remove:keep"],"custom":null}]})).await?;
    assert_eq!(result(&s, &turn).await?["deleted"], true);
    assert_eq!(listed(&api).await?, json!([]));
    s.finish().await
}

#[tokio::test]
async fn chat_tools_refused_in_read_only_and_unattended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup =
        Setup::new("COMPUTER-CHAT-DISABLED")?.clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?;
    let (_server, s, _) = start(
        setup,
        vec![
            bridge("read-only", "computer_add", &add_args()),
            bridge("unattended", "computer_add", &add_args()),
        ],
    )
    .await?;
    let sent = s.gw.post("/messages", json!({
        "chat_id":"general","text":ADD,"client_message_id":"computer-chat-read-only","access_mode":"read_only"
    })).await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let turn = s.gw.accepted_turn(sent.data()).await?;
    assert_eq!(result(&s, &turn).await?["error"]["code"], "disabled_tool");

    let created =
        s.gw.post(
            "/automations",
            json!({
                "title":ADD,"prompt_body":ADD,"target_session_id":"general","schedule_type":"once",
                "run_at":"2000-01-01T00:00:00.000Z","access_mode":"full_access"
            }),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["automation"]["id"].as_str().unwrap();
    let due = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(due.status, 202, "{}", due.text);
    let deadline = Instant::now() + Duration::from_secs(20);
    let turn = loop {
        let runs = s.gw.get(&format!("/automations/{id}/runs")).await?;
        assert_eq!(runs.status, 200, "{}", runs.text);
        if let Some(turn) = runs.data()["runs"][0]["turn_id"].as_str() {
            break turn.to_owned();
        }
        assert!(Instant::now() < deadline, "{}", runs.text);
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(result(&s, &turn).await?["error"]["code"], "disabled_tool");
    s.finish().await
}
