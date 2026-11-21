//! A local SSH server shared by SSH scenarios.
use super::HarnessError;
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

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
