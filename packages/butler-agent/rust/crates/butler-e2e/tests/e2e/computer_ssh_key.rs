//! SSH key setup through the local-admin API and the chat retry card.
#![allow(clippy::unwrap_used, reason = "test assertions")]

use super::{
    ask_user::{pending, reply},
    computer_chat::{ALIAS, add_questions, bridge, listed, result, ssh_fixture, start},
    computer_chat_retry::next_card,
    remote_deploy::{Files, RemoteHome},
    tools_direct_args::call,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    agent::Launch,
    fake_servers::FakeServer,
    harness_error,
    install_fixture::{build_archive, write_update_manifest},
    remote_home::versions_on_disk,
    scenario::{Scenario, Setup},
    security::AdminClient,
    ssh_shim,
    sshd::{TestSshd, user_ssh_config},
};
use butler_platform::remote_ssh::CONFIG_FIXTURE;
use reqwest::Method;
use serde_json::{Value, json};
use std::{fs, io::Write, path::Path, process::Command};

const PASSWORD: &str = "fixture-password";
const WRONG_PASSWORD: &str = "incorrect-fixture-password";
const ORIGINAL_KEYS: &str = "# existing entries\n\n# keep this spacing  \n";

fn password_fixture(
    setup: Setup,
    remote_home: &Path,
    password: &str,
) -> Result<(Setup, TestSshd), HarnessError> {
    let home = &setup.sandbox.home;
    let config = user_ssh_config(home)?;
    let admin = home.join("admin");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&admin)
        .output()?;
    assert!(generated.status.success());
    fs::create_dir_all(remote_home.join(".ssh"))?;
    fs::write(remote_home.join(".ssh/authorized_keys"), ORIGINAL_KEYS)?;
    let sshd = TestSshd::start_with_user_keys(
        &home.join("sshd"),
        &admin.with_extension("pub"),
        remote_home,
    )?;
    writeln!(
        fs::OpenOptions::new().append(true).open(&config)?,
        "\nHost {ALIAS}\n  HostName 127.0.0.1\n  Port {}\n  IdentityFile none\n  IdentityAgent none",
        sshd.port,
    )?;
    let host = fs::read_to_string(sshd.host_key.with_extension("pub"))?;
    fs::write(
        home.join(".ssh/known_hosts"),
        format!("[127.0.0.1]:{} {host}", sshd.port),
    )?;
    // The comparison file is fixture input, outside the agent's HOME, data and TMPDIR.
    let path = ssh_shim::write(&setup.sandbox.root.join("ssh-bin"), &admin, password)?;
    Ok((
        setup
            .env(CONFIG_FIXTURE, config.to_string_lossy())
            .env("PATH", path),
        sshd,
    ))
}

async fn add_with_password(
    password: &str,
) -> Result<(Scenario, RemoteHome, TestSshd, AdminClient, String), HarnessError> {
    let setup = Setup::new("COMPUTER-SSH-KEY-ADD")?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.home = format!(
        "/tmp/brd-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    )
    .into();
    launch.data = launch.home.join(".butler-remote/data");
    fs::create_dir_all(launch.home.join("work"))?;
    let versions = versions_on_disk(&launch.home, &setup.sandbox.root)?;
    let remote = RemoteHome(launch, versions);
    let (setup, sshd) = password_fixture(setup, &remote.0.home, password)?;
    let files_root = setup.sandbox.root.join("release");
    fs::create_dir(&files_root)?;
    let files = Files::start(files_root.clone()).await?;
    let s = setup
        .env("BUTLER_REMOTE_RELEASE_BASE", &files.base)
        .start()
        .await?;
    let version = s.gw.get("/health").await?.data()["agent_version"]
        .as_str()
        .unwrap()
        .to_owned();
    let (binary, resources, base, archive_version) = (
        s.sandbox.binary.clone(),
        s.sandbox.resources.clone(),
        files.base.clone(),
        version.clone(),
    );
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let archive = build_archive(&files_root, &archive_version, &binary, &resources)?;
        let platform = butler_platform::launcher::release_platform();
        let path = files_root.join("agent-update-manifest.json");
        write_update_manifest(&path, &[(Some(platform), &archive)])?;
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path)?)?;
        let name = archive.path.file_name().unwrap().to_str().unwrap();
        manifest["artifacts"][0]["artifact_url"] = json!(format!("{base}/{name}"));
        fs::write(path, serde_json::to_vec(&manifest)?)?;
        Ok(())
    })
    .await
    .map_err(|error| harness_error(error.to_string()))??;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let keys = remote.0.home.join(".ssh/authorized_keys");
    let mut add =
        json!({"name":"Studio","address":ALIAS,"folder":"~/work","password":WRONG_PASSWORD});
    let refused = api
        .send(Method::POST, "/computers", Some(add.clone()), &[])
        .await?;
    assert_eq!(refused.status, 422);
    assert_eq!(refused.error_code(), Some("ssh_password_wrong"));
    assert_eq!(listed(&api).await?, json!([]));
    let unchanged = fs::read(&keys)? == ORIGINAL_KEYS.as_bytes();
    assert!(unchanged, "wrong password changed authorized_keys");

    add["password"] = json!(password);
    let added = api.send(Method::POST, "/computers", Some(add), &[]).await?;
    assert_eq!(added.status, 201);
    let computer = &added.data()["computer"];
    assert_eq!(computer["managed_key"], true);
    assert!(computer["key_file"].is_null());
    let keys = fs::read_to_string(keys)?;
    let mut added_lines = keys.strip_prefix(ORIGINAL_KEYS).unwrap().lines();
    let comment = added_lines
        .next()
        .unwrap()
        .split_whitespace()
        .last()
        .unwrap();
    assert!(
        comment
            .strip_prefix("butler@")
            .is_some_and(|suffix| !suffix.is_empty())
    );
    assert!(added_lines.next().is_none());

    let id = computer["id"].as_str().unwrap().to_owned();
    let count = s.sandbox.root.join("ssh-bin/password-count");
    assert_eq!(fs::read_to_string(&count)?, "2\n");
    let started = api
        .send(Method::POST, &format!("/computers/{id}/start"), None, &[])
        .await?;
    assert_eq!(started.status, 200, "{started:?}");
    assert_eq!(started.data(), &json!({"state":"ready","version":version}));
    assert_eq!(fs::read_to_string(&count)?, "2\n");
    Ok((s, remote, sshd, api, id))
}

#[tokio::test]
async fn add_with_password_installs_and_uses_the_device_key() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (s, remote, _sshd, _api, _id) = add_with_password(PASSWORD).await?;
    drop(remote);
    s.finish().await
}

async fn retry_with_password(
    password: &str,
) -> Result<(Scenario, TestSshd, FakeServer), HarnessError> {
    let setup = Setup::new("COMPUTER-SSH-KEY-RETRY")?;
    let home = setup.sandbox.home.clone();
    let (setup, sshd) = password_fixture(setup, &home, password)?;
    let (server, s, api) = start(setup, vec![
        bridge("add", "computer_add", &json!({"name":"Studio","address":ALIAS,"folder":"~","model":"none"})),
        call("reserved", "ask_user", &json!({"questions":[{
            "id":"connection","eyebrow":"Connection","title":"Pick an option","kind":"single","allow_custom":false,
            "options":[{"id":"password_setup","label":"Set up with password","kind":"password_setup"},
                       {"id":"none","label":"Skip"}]
        }]})),
    ]).await?;
    let turn = s.gw.say_turn("general", "Add my Studio computer.").await?;
    let card = pending(&s, &turn, add_questions(ALIAS)).await?;
    reply(
        &s,
        &card,
        json!({"status":"answered","answers":[
            {"id":"computer_add.name","selected":["proposed"],"custom":null},
            {"id":"computer_add.address","selected":["proposed"],"custom":null},
            {"id":"computer_add.folder","selected":["proposed"],"custom":null},
            {"id":"computer_add.model","selected":["model:none"],"custom":null}
        ]}),
    )
    .await?;

    let mut previous = card;
    for (code, reason, password) in [
        (
            "ssh_auth_failed",
            "키로 로그인할 수 없습니다",
            WRONG_PASSWORD,
        ),
        ("ssh_password_wrong", "비밀번호가 맞지 않습니다", password),
    ] {
        let port = format!("computer_add:{code}.port");
        let key_file = format!("computer_add:{code}.key_file");
        let retry = next_card(&s, &turn, previous["request_ref"].as_str().unwrap(), json!({"questions":[
            {"id":port,"eyebrow":"포트","title":format!("{reason}. Studio의 포트"),"kind":"single","allow_custom":true,
             "options":[{"id":"none","label":"설정 안 함"}]},
            {"id":key_file,"eyebrow":"키 파일","title":format!("{reason}. Studio의 키 파일"),"kind":"single","allow_custom":true,
             "options":[{"id":"password_setup","label":"비밀번호로 연결 설정","description":"Studio","kind":"password_setup"},
                        {"id":"none","label":"설정 안 함"}]}
        ]})).await?;
        assert_eq!(listed(&api).await?, json!([]));
        let stored = api
            .send(
                Method::POST,
                "/computers/password",
                Some(json!({
                    "request_ref":retry["request_ref"],"password":password
                })),
                &[],
            )
            .await?;
        assert_eq!(stored.status, 200);
        reply(
            &s,
            &retry,
            json!({"status":"answered","answers":[
                {"id":port,"selected":[],"custom":null,"skipped":true},
                {"id":key_file,"selected":["password_setup"],"custom":null}
            ]}),
        )
        .await?;
        previous = retry;
    }
    let output = result(&s, &turn).await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["retry"], "answered");
    let computers = listed(&api).await?;
    assert_eq!(computers[0]["id"], output["computer"]["id"]);
    assert_eq!(computers[0]["managed_key"], true);
    let saved: Value =
        serde_json::from_slice(&fs::read(s.sandbox.data.join("config/computers.json"))?)?;
    let record = &saved["computers"][0];
    assert_eq!(record["id"], computers[0]["id"]);
    assert_eq!(record["managed_key"], true);
    assert_eq!(record["key_added"], true);
    assert!(record["key_file"].is_null());

    let turn =
        s.gw.say_turn("general", "Offer a connection option.")
            .await?;
    let refused = result(&s, &turn).await?;
    assert_eq!(refused["error"]["code"], "invalid_arguments");
    assert_eq!(
        refused["error"]["message"],
        "password_setup options are reserved"
    );
    Ok((s, sshd, server))
}

#[tokio::test]
async fn retry_card_password_setup_saves_a_managed_computer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (s, _sshd, _server) = retry_with_password(PASSWORD).await?;
    s.finish().await
}

#[tokio::test]
async fn delete_removes_the_key_line() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (s, remote, _sshd, api, id) = add_with_password(PASSWORD).await?;
    let removed = api
        .send(Method::DELETE, &format!("/computers/{id}"), None, &[])
        .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_eq!(removed.data()["key_removed"], true);
    let original_restored =
        fs::read(remote.0.home.join(".ssh/authorized_keys"))? == ORIGINAL_KEYS.as_bytes();
    assert!(original_restored, "delete did not restore authorized_keys");
    drop(remote);
    s.finish().await
}

#[tokio::test]
async fn publickey_only_server_is_refused_before_login() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-SSH-KEY-PUBLICKEY-ONLY")?;
    let (_sshd, config) = ssh_fixture(&setup)?;
    let keys = setup.sandbox.home.join("sshd/authorized_keys");
    let original = fs::read(&keys)?;
    let s = setup.env(CONFIG_FIXTURE, config).start().await?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let refused = api
        .send(
            Method::POST,
            "/computers",
            Some(json!({
                "name":"Studio","address":ALIAS,"folder":"~","password":PASSWORD
            })),
            &[],
        )
        .await?;
    assert_eq!(refused.status, 422);
    assert_eq!(refused.error_code(), Some("ssh_password_not_allowed"));
    let unchanged = fs::read(keys)? == original;
    assert!(unchanged, "password refusal changed authorized_keys");
    assert!(!s.sandbox.home.join(".ssh/authorized_keys").exists());
    assert!(!s.sandbox.data.join("auth/device-ssh-key.json").exists());
    s.finish().await
}

#[tokio::test]
async fn password_never_persists() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let password = format!("ssh-key-persistence-{}", uuid::Uuid::new_v4());
    let encoded = STANDARD.encode(&password);
    let needles = [password.as_bytes(), encoded.as_bytes()];
    let (added, remote, _sshd, _api, _id) = add_with_password(&password).await?;
    let (retried, _retry_sshd, _server) = retry_with_password(&password).await?;
    for s in [&added, &retried] {
        for root in [
            &s.sandbox.data,
            &s.sandbox.home,
            &s.sandbox.logs,
            &s.agent.launch.tmp,
        ] {
            assert_no_password(root, &needles)?;
        }
        assert!(
            fs::read_dir(s.sandbox.data.join("tmp/ssh-keys"))?
                .next()
                .is_none()
        );
    }
    assert_no_password(&remote.0.home, &needles)?;
    drop(remote);
    added.finish().await?;
    retried.finish().await
}

fn assert_no_password(dir: &Path, needles: &[&[u8]]) -> Result<(), HarnessError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            assert_no_password(&entry.path(), needles)?;
        } else if kind.is_file() {
            let bytes = fs::read(entry.path())?;
            for needle in needles {
                assert!(
                    !bytes.windows(needle.len()).any(|window| window == *needle),
                    "password persisted in {}",
                    entry.path().display()
                );
            }
        }
    }
    Ok(())
}
