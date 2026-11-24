//! Connecting and sending an owner-selected credential to a managed computer.
use super::remote_deploy::{Files, RemoteHome};
use age::x25519::Identity;
use butler_e2e::e2e::{
    HarnessError,
    agent::Launch,
    fake_chatgpt::FakeChatGptAuthority,
    harness_error,
    install_fixture::{build_archive, write_update_manifest},
    remote_home::versions_on_disk,
    scenario::{Scenario, Setup},
    security::AdminClient,
    sshd::{TestSshd, user_ssh_config},
    stop_intent::StopOnDrop,
};
use butler_platform::local_socket;
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    net::TcpStream,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) struct Deployed {
    pub(super) s: Scenario,
    pub(super) remote: RemoteHome,
    pub(super) sshd: TestSshd,
    pub(super) files: Files,
    pub(super) api: AdminClient,
    pub(super) id: String,
    pub(super) version: String,
}

pub(super) async fn deployed(id: &str, env: &[(&str, &str)]) -> Result<Deployed, HarnessError> {
    deployed_with(id, env, &[]).await
}

pub(super) async fn deployed_with(
    id: &str,
    env: &[(&str, &str)],
    main_env: &[(&str, &str)],
) -> Result<Deployed, HarnessError> {
    let setup = Setup::new(id)?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.home = PathBuf::from(format!(
        "/tmp/brd-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    launch.data = launch.home.join(".butler-remote/data");
    fs::create_dir(&launch.home)?;
    let versions = versions_on_disk(&launch.home, &setup.sandbox.root)?;
    fs::create_dir(launch.home.join("work"))?;
    let remote = RemoteHome(launch, versions);
    let key = setup.sandbox.home.join("key");
    assert!(
        Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()?
            .status
            .success()
    );
    let sshd = TestSshd::start_with_env(
        &setup.sandbox.home.join("sshd"),
        &key.with_extension("pub"),
        Some(&remote.0.home),
        env,
    )?;
    let files_root = setup.sandbox.home.join("release");
    fs::create_dir(&files_root)?;
    let files = Files::start(files_root.clone()).await?;
    let mut setup = setup.env("BUTLER_REMOTE_RELEASE_BASE", &files.base);
    for (key, value) in main_env {
        setup = setup.env(key, *value);
    }
    let home = setup.sandbox.home.clone();
    let setup = setup.env(
        butler_platform::remote_ssh::CONFIG_FIXTURE,
        user_ssh_config(&home)?.to_string_lossy(),
    );
    let s = setup.start().await?;
    let health = s.gw.get("/health").await?;
    let version = health.data()["agent_version"]
        .as_str()
        .ok_or_else(|| harness_error("missing agent version"))?;
    let archive = build_archive(
        &files_root,
        version,
        &s.sandbox.binary,
        &s.sandbox.resources,
    )?;
    let manifest_path = files_root.join("agent-update-manifest.json");
    write_update_manifest(
        &manifest_path,
        &[(
            Some(butler_platform::launcher::release_platform()),
            &archive,
        )],
    )?;
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    manifest["artifacts"][0]["artifact_url"] = json!(format!(
        "{}/{}",
        files.base,
        archive
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| harness_error("invalid archive name"))?
    ));
    manifest["artifacts"][0]["version"] = json!(version);
    manifest["artifacts"][0]["channel"] = json!("stable");
    fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let admin = s
        .agent
        .launch
        .admin_credential()
        .ok_or_else(|| harness_error("no admin credential"))?;
    let api = AdminClient::new(s.gw.clone(), admin);
    let host = json!({"address":"127.0.0.1","port":sshd.port,"key_file":key});
    let seen = api
        .send(Method::POST, "/computers/host-key", Some(host), &[])
        .await?;
    assert_eq!(seen.status, 200, "{seen:?}");
    let added = api.send(Method::POST, "/computers", Some(json!({"name":"Remote","address":"127.0.0.1","port":sshd.port,"key_file":key,"folder":remote.0.home.join("work")})), &[]).await?;
    assert_eq!(added.status, 201, "{added:?}");
    let id = added.data()["computer"]["id"]
        .as_str()
        .ok_or_else(|| harness_error("missing computer id"))?
        .to_owned();
    Ok(Deployed {
        s,
        remote,
        sshd,
        files,
        api,
        id,
        version: version.to_owned(),
    })
}

pub(super) async fn socket(
    remote: &Launch,
    method: &str,
    route: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), HarnessError> {
    let token = remote
        .data_folder_token()
        .ok_or_else(|| harness_error("no local token"))?;
    let admin = remote
        .admin_credential()
        .ok_or_else(|| harness_error("no admin credential"))?;
    let mut stream = local_socket::connect(&remote.data.join("remote/agent.sock")).await?;
    let body = body.map(ToString::to_string).unwrap_or_default();
    let request = format!(
        "{method} http://agent{route} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\nX-Butler-Admin: {admin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = String::new();
    stream.read_to_string(&mut response).await?;
    let (headers, payload) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| harness_error("invalid socket response"))?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| harness_error("invalid status"))?;
    let body = if payload.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(payload)?
    };
    Ok((status, body))
}

#[tokio::test]
async fn computer_start_hands_its_key_to_the_remote_every_time() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let Deployed {
        s,
        remote,
        sshd,
        files,
        api,
        id,
        version,
    } = deployed("COMPUTER-ACCOUNT-START", &[]).await?;
    let start = format!("/computers/{id}/start");
    let homes_path = s.sandbox.data.join("auth/computer-key-homes.json");
    let store_path = s.sandbox.data.join("auth/credential-store.json");
    let public_path = remote.0.data.join("remote/account.pub");
    let account = format!("computer_key/{id}");
    let mut original = String::new();
    for attempt in 0..2 {
        if attempt == 1 {
            drop(StopOnDrop(remote.0.clone()));
        }
        let started = api.send(Method::POST, &start, None, &[]).await?;
        assert_eq!(started.status, 200);
        assert_eq!(started.data(), &json!({"state":"ready","version":version}));
        let homes: Value = serde_json::from_slice(&fs::read(&homes_path)?)?;
        assert_eq!(homes, json!({&id:"fallback_file"}));
        let store: Value = serde_json::from_slice(&fs::read(&store_path)?)?;
        let entry = store["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["account"] == account)
            .unwrap();
        let secret = entry["secret"].as_str().unwrap();
        let identity: Identity = secret
            .parse()
            .map_err(|_| harness_error("invalid computer identity"))?;
        assert_eq!(
            fs::read_to_string(&public_path)?.trim(),
            identity.to_public().to_string()
        );
        if attempt == 0 {
            original = secret.to_owned();
        } else if secret != original {
            return Err(harness_error("computer identity changed after restart"));
        }
        let body = json!({"provider_id":"openai", "api_key": uuid::Uuid::new_v4().to_string()});
        assert_eq!(
            socket(&remote.0, "POST", "/credentials", Some(&body))
                .await?
                .0,
            201
        );
    }
    fs::write(public_path, Identity::generate().to_public().to_string())?;
    drop(StopOnDrop(remote.0.clone()));
    let mismatch = api.send(Method::POST, &start, None, &[]).await?;
    assert_eq!(mismatch.status, 409);
    assert_eq!(mismatch.error_code(), Some("remote_key_mismatch"));

    // Deletion removes the remote logs along with its data.
    let mut directories = vec![
        remote.0.data.join("logs"),
        s.sandbox.data.join("logs"),
        s.sandbox.logs.clone(),
    ];
    while let Some(dir) = directories.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                directories.push(entry.path());
            } else if entry.file_type()?.is_file() {
                assert!(
                    !fs::read(entry.path())?
                        .windows(original.len())
                        .any(|bytes| bytes == original.as_bytes())
                );
            }
        }
    }
    let deleted = api
        .send(Method::DELETE, &format!("/computers/{id}"), None, &[])
        .await?;
    assert_eq!(deleted.status, 200);
    let homes: Value = serde_json::from_slice(&fs::read(homes_path)?)?;
    assert!(homes.get(&id).is_none());
    drop((remote, sshd, files));
    s.finish().await
}

#[tokio::test]
async fn sending_a_saved_key_seals_it_on_the_computer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let Deployed {
        s,
        remote,
        sshd,
        files,
        api,
        id,
        ..
    } = deployed("COMPUTER-ACCOUNT-SEND", &[]).await?;
    let key = uuid::Uuid::new_v4().to_string();
    let saved = api
        .send(
            Method::POST,
            "/credentials",
            Some(json!({"provider_id":"openai","api_key":key})),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 201);
    let cid = saved.data()["credential"]["id"].as_str().unwrap();
    let path = format!("/computers/{id}");
    let sent = api
        .send(
            Method::PATCH,
            &path,
            Some(json!({"model_source":{"key":cid}})),
            &[],
        )
        .await?;
    assert_eq!(sent.status, 200);
    assert_eq!(sent.data()["computer"]["model_source"]["key"], cid);
    assert!(!serde_json::to_string(sent.data())?.contains(&key));
    let cipher = fs::read(remote.0.data.join("auth/remote-credentials.age"))?;
    assert!(
        !cipher
            .windows(key.len())
            .any(|bytes| bytes == key.as_bytes())
    );
    let store: Value = serde_json::from_slice(&fs::read(
        s.sandbox.data.join("auth/credential-store.json"),
    )?)?;
    let account = format!("computer_key/{id}");
    let entry = store["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["account"] == account)
        .unwrap();
    let identity: Identity = entry["secret"]
        .as_str()
        .unwrap()
        .parse()
        .map_err(|_| harness_error("invalid computer identity"))?;
    let plain = age::decrypt(&identity, &cipher).map_err(|e| harness_error(e.to_string()))?;
    let map: BTreeMap<String, String> = serde_json::from_slice(&plain)?;
    assert!(map.values().any(|value| value == &key));
    let missing = api
        .send(
            Method::PATCH,
            &path,
            Some(json!({"model_source":{"key":"missing"}})),
            &[],
        )
        .await?;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.error_code(), Some("credential_not_found"));
    let invalid = api
        .send(
            Method::PATCH,
            &path,
            Some(json!({"model_source":{"key":cid},"x":1})),
            &[],
        )
        .await?;
    assert_eq!(invalid.status, 400);
    assert_eq!(invalid.error_code(), Some("invalid_json"));
    let list = api.send(Method::GET, "/credentials", None, &[]).await?;
    assert_eq!(list.status, 200);
    assert!(
        list.data()["credentials"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == cid)
    );
    drop((remote, sshd, files));
    s.finish().await
}

#[tokio::test]
async fn computer_chatgpt_sign_in_runs_on_the_computer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let authority = FakeChatGptAuthority::start().await?;
    let api_base = format!("{}/v1", authority.issuer);
    let Deployed {
        s,
        remote,
        sshd,
        files,
        api,
        id,
        ..
    } = deployed(
        "COMPUTER-CHATGPT-SIGN-IN",
        &[
            ("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer),
            ("BUTLER_CHATGPT_API_BASE_URL", &api_base),
        ],
    )
    .await?;
    let refused =
        s.gw.post("/setup/oauth/start", json!({"redirect_port":1}))
            .await?;
    assert_eq!(refused.status, 400);
    assert_eq!(refused.error_code(), Some("invalid_request"));

    let base = format!("/computers/{id}/oauth");
    let start = format!("{base}/start");
    let pending = api.send(Method::POST, &start, Some(json!({})), &[]).await?;
    assert_eq!(pending.status, 200);
    let flow = pending.data();
    assert_eq!(flow["status"], "pending");
    let main_port = url::Url::parse(flow["redirect_uri"].as_str().unwrap())
        .unwrap()
        .port()
        .unwrap();
    let remote_port = u16::try_from(flow["callback_port"].as_u64().unwrap()).unwrap();
    assert_ne!(main_port, remote_port);
    assert!(TcpStream::connect(("127.0.0.1", main_port)).is_ok());
    assert!(TcpStream::connect(("127.0.0.1", remote_port)).is_ok());
    let flow_id = flow["flow_id"].as_str().unwrap();
    let cancel = api
        .send(
            Method::POST,
            &format!("{base}/{flow_id}/cancel"),
            Some(json!({})),
            &[],
        )
        .await?;
    assert_eq!(cancel.data()["status"], "cancelled");
    let deadline = Instant::now() + Duration::from_secs(5);
    while [main_port, remote_port]
        .into_iter()
        .any(|p| TcpStream::connect(("127.0.0.1", p)).is_ok())
    {
        assert!(
            Instant::now() < deadline,
            "a callback listener survived cancellation"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let pending = api.send(Method::POST, &start, Some(json!({})), &[]).await?;
    let flow = pending.data();
    let main_port = url::Url::parse(flow["redirect_uri"].as_str().unwrap())
        .unwrap()
        .port()
        .unwrap();
    let (status, page) = authority.browser(flow).await?;
    assert_eq!(status, 200);
    assert!(page.contains("Signed in to ChatGPT"));
    let path = format!("{base}/{}", flow["flow_id"].as_str().unwrap());
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let poll = api.send(Method::GET, &path, None, &[]).await?;
        if poll.data()["status"] == "completed" {
            break;
        }
        assert_eq!(poll.data()["status"], "pending");
        assert!(Instant::now() < deadline, "sign-in did not complete");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while TcpStream::connect(("127.0.0.1", main_port)).is_ok() {
        assert!(
            Instant::now() < deadline,
            "the completed callback listener stayed open"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        super::chatgpt_sign_in::account(&s).await?["status"],
        "signed_out"
    );
    let cipher = fs::read(remote.0.data.join("auth/chatgpt.json"))?;
    for secret in authority.issued() {
        assert!(!cipher.windows(secret.len()).any(|w| w == secret.as_bytes()));
    }
    let store: Value = serde_json::from_slice(&fs::read(
        s.sandbox.data.join("auth/credential-store.json"),
    )?)?;
    let account = format!("computer_key/{id}");
    let entry = store["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["account"] == account)
        .unwrap();
    let identity: Identity = entry["secret"]
        .as_str()
        .unwrap()
        .parse()
        .map_err(|_| harness_error("invalid computer identity"))?;
    let plain = age::decrypt(&identity, &cipher).map_err(|e| harness_error(e.to_string()))?;
    let registration: Value = serde_json::from_slice(&plain)?;
    assert!(registration["client_id"].is_string());
    drop((remote, sshd, files));
    s.finish().await
}
