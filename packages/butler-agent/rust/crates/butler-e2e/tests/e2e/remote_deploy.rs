//! Main-managed remote archive placement, integrity and removal over SSH.
use axum::response::IntoResponse;
use butler_e2e::e2e::{
    HarnessError,
    agent::Launch,
    install_fixture::{build_archive, write_update_manifest},
    scenario::Setup,
    security::AdminClient,
    sshd::TestSshd,
    stop_intent::{StopOnDrop, instance_record},
};
use butler_platform::{instance::process_start, local_socket};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) struct RemoteHome(pub(super) Launch);

impl Drop for RemoteHome {
    fn drop(&mut self) {
        drop(StopOnDrop(self.0.clone()));
        let _ = fs::remove_dir_all(&self.0.home);
    }
}

/// One file server for the manifest and archive; the counter measures archive downloads.
pub(super) struct Files {
    pub(super) base: String,
    pub(super) downloads: Arc<AtomicUsize>,
    pub(super) task: tokio::task::JoinHandle<()>,
}

impl Files {
    pub(super) async fn start(root: PathBuf) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let downloads = Arc::new(AtomicUsize::new(0));
        let count = downloads.clone();
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let root = root.clone();
            let count = count.clone();
            async move {
                let name = uri.path().rsplit('/').next().unwrap_or_default();
                match tokio::fs::File::open(root.join(name)).await {
                    Ok(file) => {
                        if name.ends_with(".tar.gz") {
                            count.fetch_add(1, Ordering::SeqCst);
                        }
                        axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file))
                            .into_response()
                    }
                    Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
                }
            }
        });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            base,
            downloads,
            task,
        })
    }
}

impl Drop for Files {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn remote_start_places_verifies_and_starts_the_main_version() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("REMOTE-DEPLOY-START")?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.home = PathBuf::from(format!(
        "/tmp/brd-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    launch.data = launch.home.join(".butler-remote/data");
    fs::create_dir(&launch.home)?;
    let remote = RemoteHome(launch);
    let key = setup.sandbox.home.join("key");
    assert!(
        Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()?
            .status
            .success()
    );
    let sshd = TestSshd::start(
        &setup.sandbox.home.join("sshd"),
        &key.with_extension("pub"),
        Some(&remote.0.home),
    )?;
    let files_root = setup.sandbox.home.join("release");
    fs::create_dir(&files_root)?;
    let files = Files::start(files_root.clone()).await?;
    let s = setup
        .env("BUTLER_REMOTE_RELEASE_BASE", &files.base)
        .start()
        .await?;
    let health = s.gw.get("/health").await?;
    let version = health.data()["agent_version"].as_str().unwrap();
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
        archive.path.file_name().unwrap().to_str().unwrap()
    ));
    manifest["artifacts"][0]["version"] = json!(version);
    manifest["artifacts"][0]["channel"] = json!("stable");
    fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = json!({"address":"127.0.0.1","port":sshd.port,"key_file":key});
    let seen = api
        .send(Method::POST, "/computers/host-key", Some(host), &[])
        .await?;
    assert_eq!(seen.status, 200, "{seen:?}");
    let added = api.send(Method::POST, "/computers", Some(json!({"name":"Remote","address":"127.0.0.1","port":sshd.port,"key_file":key,"folder":remote.0.home,"host_fingerprint":seen.data()["fingerprint"]})), &[]).await?;
    assert_eq!(added.status, 201, "{added:?}");
    let start = format!(
        "/computers/{}/start",
        added.data()["computer"]["id"].as_str().unwrap()
    );
    let started = api.send(Method::POST, &start, None, &[]).await?;
    assert_eq!(started.status, 200, "{started:?}");
    assert_eq!(started.data(), &json!({"state":"ready","version":version}));
    let root = remote.0.home.join(".butler-remote");
    assert_eq!(
        fs::read_link(root.join("current"))?,
        PathBuf::from(format!("versions/{version}-{}", &archive.sha256[..8]))
    );
    let token = remote.0.data_folder_token().unwrap();
    let mut socket = local_socket::connect(&remote.0.data.join("remote/agent.sock")).await?;
    socket.write_all(format!("GET /health HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").as_bytes()).await?;
    let mut response = String::new();
    socket.read_to_string(&mut response).await?;
    let health: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1)?;
    assert_eq!(health["data"]["agent_version"], version);
    assert_eq!(files.downloads.load(Ordering::SeqCst), 1);
    let again = api.send(Method::POST, &start, None, &[]).await?;
    assert_eq!(again.status, 200, "{again:?}");
    assert_eq!(again.data(), &json!({"state":"ready","version":version}));
    assert_eq!(files.downloads.load(Ordering::SeqCst), 1);
    drop(remote);
    drop(sshd);
    s.finish().await
}

#[tokio::test]
async fn remote_start_rejects_a_bad_checksum() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("REMOTE-DEPLOY-CHECKSUM")?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.home = PathBuf::from(format!(
        "/tmp/brd-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    launch.data = launch.home.join(".butler-remote/data");
    fs::create_dir(&launch.home)?;
    let remote = RemoteHome(launch);
    let key = setup.sandbox.home.join("key");
    assert!(
        Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()?
            .status
            .success()
    );
    let sshd = TestSshd::start(
        &setup.sandbox.home.join("sshd"),
        &key.with_extension("pub"),
        Some(&remote.0.home),
    )?;
    let files_root = setup.sandbox.home.join("release");
    fs::create_dir(&files_root)?;
    let files = Files::start(files_root.clone()).await?;
    let s = setup
        .env("BUTLER_REMOTE_RELEASE_BASE", &files.base)
        .start()
        .await?;
    let health = s.gw.get("/health").await?;
    let version = health.data()["agent_version"].as_str().unwrap();
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
        archive.path.file_name().unwrap().to_str().unwrap()
    ));
    manifest["artifacts"][0]["version"] = json!(version);
    manifest["artifacts"][0]["channel"] = json!("stable");
    manifest["artifacts"][0]["sha256"] = json!("0".repeat(64));
    manifest["artifacts"][0]["integrity"]["digest"] = json!("0".repeat(64));
    fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = json!({"address":"127.0.0.1","port":sshd.port,"key_file":key});
    let seen = api
        .send(Method::POST, "/computers/host-key", Some(host), &[])
        .await?;
    assert_eq!(seen.status, 200, "{seen:?}");
    let added = api.send(Method::POST, "/computers", Some(json!({"name":"Remote","address":"127.0.0.1","port":sshd.port,"key_file":key,"folder":remote.0.home,"host_fingerprint":seen.data()["fingerprint"]})), &[]).await?;
    assert_eq!(added.status, 201, "{added:?}");
    let start = format!(
        "/computers/{}/start",
        added.data()["computer"]["id"].as_str().unwrap()
    );
    let started = api.send(Method::POST, &start, None, &[]).await?;
    assert_eq!(started.status, 422, "{started:?}");
    assert_eq!(started.error_code(), Some("checksum_mismatch"));
    let root = remote.0.home.join(".butler-remote");
    assert!(!root.join("current").exists());
    assert_eq!(fs::read_dir(root.join("versions"))?.count(), 0);
    drop(remote);
    drop(sshd);
    s.finish().await
}

#[tokio::test]
async fn remote_delete_stops_and_removes_the_remote() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("REMOTE-DEPLOY-DELETE")?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.home = PathBuf::from(format!(
        "/tmp/brd-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    launch.data = launch.home.join(".butler-remote/data");
    fs::create_dir(&launch.home)?;
    let remote = RemoteHome(launch);
    let key = setup.sandbox.home.join("key");
    assert!(
        Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()?
            .status
            .success()
    );
    let sshd = TestSshd::start(
        &setup.sandbox.home.join("sshd"),
        &key.with_extension("pub"),
        Some(&remote.0.home),
    )?;
    let files_root = setup.sandbox.home.join("release");
    fs::create_dir(&files_root)?;
    let files = Files::start(files_root.clone()).await?;
    let s = setup
        .env("BUTLER_REMOTE_RELEASE_BASE", &files.base)
        .start()
        .await?;
    let health = s.gw.get("/health").await?;
    let version = health.data()["agent_version"].as_str().unwrap();
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
        archive.path.file_name().unwrap().to_str().unwrap()
    ));
    manifest["artifacts"][0]["version"] = json!(version);
    manifest["artifacts"][0]["channel"] = json!("stable");
    fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = json!({"address":"127.0.0.1","port":sshd.port,"key_file":key});
    let seen = api
        .send(Method::POST, "/computers/host-key", Some(host), &[])
        .await?;
    assert_eq!(seen.status, 200, "{seen:?}");
    let added = api.send(Method::POST, "/computers", Some(json!({"name":"Remote","address":"127.0.0.1","port":sshd.port,"key_file":key,"folder":remote.0.home,"host_fingerprint":seen.data()["fingerprint"]})), &[]).await?;
    assert_eq!(added.status, 201, "{added:?}");
    let computer = format!(
        "/computers/{}",
        added.data()["computer"]["id"].as_str().unwrap()
    );
    let started = api
        .send(Method::POST, &format!("{computer}/start"), None, &[])
        .await?;
    assert_eq!(started.status, 200, "{started:?}");
    assert_eq!(started.data(), &json!({"state":"ready","version":version}));
    let record = instance_record(&remote.0.data).unwrap();
    let pid = u32::try_from(record["pid"].as_u64().unwrap()).unwrap();
    let deleted = api.send(Method::DELETE, &computer, None, &[]).await?;
    assert_eq!(deleted.status, 200, "{deleted:?}");
    assert_eq!(
        deleted.data(),
        &json!({"deleted":true,"remote_cleaned":true})
    );
    assert!(!remote.0.home.join(".butler-remote").exists());
    assert!(
        process_start(pid)
            .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?
            .is_none()
    );
    drop(remote);
    drop(sshd);
    s.finish().await
}
