//! Owner-confirmed remote computer registration through the local-admin API.
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient, sshd::TestSshd};
use reqwest::Method;
use serde_json::json;
use std::{fs, path::Path, process::Command};

#[tokio::test]
async fn computer_add_confirms_the_host_key_then_lists_and_removes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-REGISTRY")?;
    let home = &setup.sandbox.home;
    fs::create_dir_all(home.join(".ssh"))?;
    let key = home.join(".ssh/id_ed25519");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()?;
    assert!(generated.status.success());
    let sshd = TestSshd::start(&home.join("sshd"), &key.with_extension("pub"), Some(home))?;
    let host_public = fs::read_to_string(sshd.host_key.with_extension("pub"))?;
    let host_base64 = host_public.split_whitespace().nth(1).unwrap();
    let fingerprint = Command::new("ssh-keygen")
        .args(["-l", "-E", "sha256", "-f"])
        .arg(sshd.host_key.with_extension("pub"))
        .output()?;
    assert!(fingerprint.status.success());
    let fingerprint = String::from_utf8_lossy(&fingerprint.stdout)
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let host = json!({"address":"127.0.0.1", "port":sshd.port, "key_file":key});
    let mut add = json!({"name":"Remote", "address":"127.0.0.1", "port":sshd.port, "key_file":key, "folder":home});
    let s = setup.start().await?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let seen = api
        .send(Method::POST, "/computers/host-key", Some(host.clone()), &[])
        .await?;
    assert_eq!(seen.status, 200, "{seen:?}");
    assert_eq!(seen.data()["trusted"], false);
    assert_eq!(seen.data()["fingerprint"], fingerprint);
    assert_eq!(seen.data()["key_type"], "ED25519");
    let unconfirmed = api
        .send(Method::POST, "/computers", Some(add.clone()), &[])
        .await?;
    assert_eq!(unconfirmed.status, 409, "{unconfirmed:?}");
    assert_eq!(unconfirmed.error_code(), Some("host_key_unconfirmed"));
    let listed = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"], json!([]));
    add["host_fingerprint"] = fingerprint.into();
    let added = api.send(Method::POST, "/computers", Some(add), &[]).await?;
    assert_eq!(added.status, 201, "{added:?}");
    let computer = &added.data()["computer"];
    let runner = butler_platform::launcher::release_platform();
    let (os, arch) = runner.split_once('-').unwrap();
    assert_eq!(computer["os"], if os == "darwin" { "macos" } else { os });
    assert_eq!(computer["arch"], arch);
    assert!(computer.get("host_keys").is_none());
    let listed = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"], json!([computer]));
    let trusted = api
        .send(Method::POST, "/computers/host-key", Some(host), &[])
        .await?;
    assert_eq!(trusted.status, 200, "{trusted:?}");
    assert_eq!(trusted.data(), &json!({"trusted":true}));
    let removed = api
        .send(
            Method::DELETE,
            &format!("/computers/{}", computer["id"].as_str().unwrap()),
            None,
            &[],
        )
        .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    assert_eq!(
        removed.data(),
        &json!({"deleted":true,"remote_cleaned":true})
    );
    let listed = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"], json!([]));
    let saved = fs::read_to_string(s.sandbox.data.join("config/computers.json"))?;
    assert!(!saved.contains(host_base64));
    s.finish().await
}

#[tokio::test]
async fn computer_add_reports_each_ssh_failure() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-FAILURES")?;
    let home = &setup.sandbox.home;
    fs::create_dir_all(home.join(".ssh"))?;
    let key = home.join(".ssh/id_ed25519");
    let wrong_key = home.join(".ssh/other_ed25519");
    for key in [&key, &wrong_key] {
        let generated = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(key)
            .output()?;
        assert!(generated.status.success());
    }
    let mut sshd = TestSshd::start(&home.join("sshd"), &key.with_extension("pub"), Some(home))?;
    let closed_port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let host = json!({"address":"127.0.0.1", "port":sshd.port, "key_file":key});
    let mut add = json!({"name":"First", "address":"127.0.0.1", "port":sshd.port, "key_file":key, "folder":home});
    let missing = home.join("missing");
    let s = setup.start().await?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let unreachable = api
        .send(
            Method::POST,
            "/computers/host-key",
            Some(json!({"address":"127.0.0.1", "port":closed_port, "key_file":key})),
            &[],
        )
        .await?;
    assert_eq!(unreachable.status, 422, "{unreachable:?}");
    assert_eq!(unreachable.error_code(), Some("ssh_unreachable"));
    let seen = api
        .send(Method::POST, "/computers/host-key", Some(host.clone()), &[])
        .await?;
    assert_eq!(seen.status, 200, "{seen:?}");
    add["host_fingerprint"] = seen.data()["fingerprint"].clone();
    add["key_file"] = json!(wrong_key);
    let denied = api
        .send(Method::POST, "/computers", Some(add.clone()), &[])
        .await?;
    assert_eq!(denied.status, 422, "{denied:?}");
    assert_eq!(denied.error_code(), Some("ssh_auth_failed"));
    add["key_file"] = json!(key);
    let first = api
        .send(Method::POST, "/computers", Some(add.clone()), &[])
        .await?;
    assert_eq!(first.status, 201, "{first:?}");
    add["name"] = json!("Second");
    add.as_object_mut().unwrap().remove("host_fingerprint");
    let folder = add["folder"].clone();
    add["folder"] = json!(missing);
    let absent = api
        .send(Method::POST, "/computers", Some(add.clone()), &[])
        .await?;
    assert_eq!(absent.status, 422, "{absent:?}");
    assert_eq!(absent.error_code(), Some("computer_folder_missing"));
    add["folder"] = folder;
    let second = api.send(Method::POST, "/computers", Some(add), &[]).await?;
    assert_eq!(second.status, 201, "{second:?}");
    let removed = api
        .send(
            Method::DELETE,
            &format!(
                "/computers/{}",
                first.data()["computer"]["id"].as_str().unwrap()
            ),
            None,
            &[],
        )
        .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    let trusted = api
        .send(Method::POST, "/computers/host-key", Some(host.clone()), &[])
        .await?;
    assert_eq!(trusted.status, 200, "{trusted:?}");
    assert_eq!(trusted.data(), &json!({"trusted":true}));
    sshd.restart_with_new_host_key()?;
    let changed = api
        .send(Method::POST, "/computers/host-key", Some(host), &[])
        .await?;
    assert_eq!(changed.status, 422, "{changed:?}");
    assert_eq!(changed.error_code(), Some("host_key_changed"));
    s.finish().await
}
