//! Windows computer registration through the local-admin API.
use butler_e2e::e2e::{
    HarnessError,
    scenario::Setup,
    security::AdminClient,
    sshd::{TestSshd, user_ssh_config},
};
use butler_platform::{launcher::mark_executable, remote_ssh};
use reqwest::Method;
use serde_json::json;
use std::{fs, path::Path, process::Command};

#[tokio::test]
async fn computer_add_probes_windows_hosts_with_powershell() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-WINDOWS")?;
    let home = setup.sandbox.home.clone();
    fs::create_dir_all(home.join(".ssh"))?;
    let key = home.join(".ssh/id_ed25519");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()?;
    assert!(generated.status.success());

    let fake_bin = home.join("bin");
    fs::create_dir(&fake_bin)?;
    let sh = fake_bin.join("sh");
    let powershell = fake_bin.join("powershell");
    let output = fake_bin.join("powershell.out");
    fs::write(&sh, "#!/bin/sh\ncat >/dev/null; exit 1\n")?;
    mark_executable(&sh).unwrap_or(Ok(()))?;
    fs::write(
        &powershell,
        format!("#!/bin/sh\ncat \"{}\"\n", output.display()),
    )?;
    mark_executable(&powershell).unwrap_or(Ok(()))?;
    let sshd = TestSshd::start_with_env(
        &home.join("sshd"),
        &key.with_extension("pub"),
        Some(&home),
        &[("PATH", &format!("{}:/usr/bin:/bin", fake_bin.display()))],
    )?;
    let host_public = fs::read_to_string(sshd.host_key.with_extension("pub"))?;
    let host_kind_blob = host_public
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    fs::write(
        home.join(".ssh/known_hosts"),
        format!("[127.0.0.1]:{} {host_kind_blob}\n", sshd.port),
    )?;
    let setup = setup.env(
        remote_ssh::CONFIG_FIXTURE,
        user_ssh_config(&home)?.to_string_lossy(),
    );
    let s = setup.start().await?;
    let api = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut input = json!({"name":"Win", "address":"127.0.0.1", "port":sshd.port, "key_file":key, "folder":r"~\proj"});

    let amd64 = "os=Windows\r\narch=AMD64\r\nfolder=ok\r\n";
    fs::write(&output, amd64)?;
    let added = api
        .send(Method::POST, "/computers", Some(input.clone()), &[])
        .await?;
    assert_eq!(added.status, 201, "{added:?}");
    let listed = api.send(Method::GET, "/computers", None, &[]).await?;
    assert_eq!(listed.status, 200, "{listed:?}");
    assert_eq!(listed.data()["computers"][0]["os"], "windows");
    assert_eq!(listed.data()["computers"][0]["arch"], "x64");

    fs::write(&output, "os=Windows\r\narch=ARM64\r\nfolder=ok\r\n")?;
    input["name"] = json!("Arm");
    let unsupported = api
        .send(Method::POST, "/computers", Some(input.clone()), &[])
        .await?;
    assert_eq!(unsupported.status, 422, "{unsupported:?}");
    assert_eq!(unsupported.error_code(), Some("unsupported_computer"));

    fs::remove_file(sh)?;
    let uname = fake_bin.join("uname");
    fs::write(
        &uname,
        "#!/bin/sh\nif [ \"$1\" = -s ]; then echo MINGW64_NT-10.0-26100; else echo x86_64; fi\n",
    )?;
    mark_executable(&uname).unwrap_or(Ok(()))?;
    fs::write(&output, amd64)?;
    input["name"] = json!("Msys");
    let added = api
        .send(Method::POST, "/computers", Some(input), &[])
        .await?;
    assert_eq!(added.status, 201, "{added:?}");
    assert_eq!(added.data()["computer"]["os"], "windows");
    s.finish().await
}
