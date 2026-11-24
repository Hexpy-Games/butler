//! A local SSH server shared by SSH scenarios.
use super::HarnessError;
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub fn user_ssh_config(home: &Path) -> std::io::Result<PathBuf> {
    let ssh = home.join(".ssh");
    std::fs::create_dir_all(&ssh)?;
    let config = ssh.join("config");
    std::fs::write(
        &config,
        format!(
            "UserKnownHostsFile {}\nGlobalKnownHostsFile none\n",
            ssh.join("known_hosts").display()
        ),
    )?;
    Ok(config)
}

/// Children this fixture started, stopped by PID on every exit path.
struct Children(Vec<Child>);

impl Drop for Children {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct TestSshd {
    pub port: u16,
    pub host_key: PathBuf,
    dir: PathBuf,
    children: Children,
}

impl TestSshd {
    pub fn start(
        dir: &Path,
        authorized_pubkey: &Path,
        home: Option<&Path>,
    ) -> Result<Self, HarnessError> {
        Self::start_with_env(dir, authorized_pubkey, home, &[])
    }

    pub fn start_with_env(
        dir: &Path,
        authorized_pubkey: &Path,
        home: Option<&Path>,
        env: &[(&str, &str)],
    ) -> Result<Self, HarnessError> {
        std::fs::create_dir_all(dir)?;
        let host_key = dir.join("host_key");
        let port = std::net::TcpListener::bind("127.0.0.1:0")?
            .local_addr()?
            .port();
        let mut server = Self {
            port,
            host_key,
            dir: dir.to_owned(),
            children: Children(Vec::new()),
        };
        server.generate_host_key()?;
        std::fs::copy(authorized_pubkey, dir.join("authorized_keys"))?;
        std::fs::write(
            dir.join("sshd_config"),
            format!(
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\n\
             PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n\
             StrictModes no\nPidFile {}\n",
                server.host_key.display(),
                dir.join("authorized_keys").display(),
                dir.join("sshd.pid").display(),
            ),
        )?;
        if let Some(home) = home {
            use std::io::Write;
            let mut config = std::fs::OpenOptions::new()
                .append(true)
                .open(dir.join("sshd_config"))?;
            write!(
                config,
                "SetEnv HOME={0} BUTLER_E2E_TIER=stub BUTLER_E2E_EMBED_LOCAL_ONLY=1 BUTLER_E2E_EMBED_SOURCES=http://127.0.0.1:9 BUTLER_PROVIDER_QUOTA_POLLING=0 BUTLER_SERVICE_MANAGER=off BUTLER_SECRET_STORE=file BUTLER_BROWSER_HEADLESS=off BUTLER_BROWSER_APP=off BUTLER_BROWSER_PROFILES_HOME={0} BUTLER_AGENT_IMPORT_HOME={0} BUTLER_TEST_SECRET_STORE={0}/test-secrets/store.json",
                home.display()
            )?;
            for (key, value) in env {
                write!(config, " {key}={value}")?;
            }
            writeln!(config)?;
        }
        server.spawn()?;
        Ok(server)
    }

    #[expect(
        clippy::expect_used,
        reason = "an unavailable pgrep must fail the SSH fixture"
    )]
    pub fn connections(&self) -> Vec<u32> {
        self.children
            .0
            .iter()
            .flat_map(|child| {
                let result = Command::new("pgrep")
                    .arg("-P")
                    .arg(child.id().to_string())
                    .output();
                let output = result.expect("pgrep must enumerate fixture SSH connections");
                assert!(
                    output.status.success() || output.status.code() == Some(1),
                    "pgrep failed"
                );
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|s| s.parse::<u32>().ok())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    pub fn drop_connections(&mut self) -> Result<(), HarnessError> {
        let pids: Vec<_> = self
            .children
            .0
            .iter()
            .flat_map(|child| descendants(child.id()))
            .collect();
        self.children = Children(Vec::new());
        for pid in pids {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
        }
        Ok(())
    }

    pub fn restart(&mut self) -> Result<(), HarnessError> {
        self.spawn()
    }

    pub fn restart_with_new_host_key(&mut self) -> Result<(), HarnessError> {
        self.children = Children(Vec::new());
        std::fs::remove_file(&self.host_key)?;
        std::fs::remove_file(self.host_key.with_extension("pub"))?;
        self.generate_host_key()?;
        self.spawn()
    }

    fn generate_host_key(&self) -> Result<(), HarnessError> {
        let output = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&self.host_key)
            .stdin(Stdio::null())
            .output()?;
        if !output.status.success() {
            return Err(HarnessError(format!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(())
    }

    fn spawn(&mut self) -> Result<(), HarnessError> {
        let log = std::fs::File::create(self.dir.join("sshd.log"))?;
        self.children.0.push(
            Command::new("/usr/sbin/sshd")
                .arg("-D")
                .arg("-f")
                .arg(self.dir.join("sshd_config"))
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log)
                .spawn()?,
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::net::TcpStream::connect(("127.0.0.1", self.port)).is_err() {
            if Instant::now() > deadline {
                return Err(HarnessError("sshd did not start".into()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
}

#[expect(
    clippy::expect_used,
    reason = "an unavailable pgrep must fail the SSH fixture"
)]
fn descendants(pid: u32) -> Vec<u32> {
    let output = Command::new("pgrep")
        .arg("-P")
        .arg(pid.to_string())
        .output()
        .expect("pgrep must enumerate fixture SSH descendants");
    assert!(
        output.status.success() || output.status.code() == Some(1),
        "pgrep failed"
    );
    let mut result = Vec::new();
    for child in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|s| s.parse::<u32>().ok())
    {
        result.extend(descendants(child));
        result.push(child);
    }
    result
}
