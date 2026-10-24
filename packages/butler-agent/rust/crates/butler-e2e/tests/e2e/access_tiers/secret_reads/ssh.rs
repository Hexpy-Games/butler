//! Git over SSH from an approved command: the SSH agent authenticates, the
//! key file under `~/.ssh` stays unreadable to the command.
use super::approved;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// Children this scenario started, stopped by PID on every exit path.
struct Children(Vec<Child>, PathBuf);

impl Drop for Children {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

fn run(command: &mut Command) -> Result<String, HarnessError> {
    let output = command.stdin(Stdio::null()).output()?;
    if !output.status.success() {
        return Err(HarnessError(format!(
            "{command:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn wait_for(what: &str, ready: impl Fn() -> bool) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        if Instant::now() > deadline {
            return Err(HarnessError(format!("{what} did not start")));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// A user-level sshd on a free loopback port that accepts `key`, and an
/// agent holding it. Unix socket paths are short, so both live in a short
/// temporary folder.
fn servers(home: &Path, key: &Path) -> Result<(Children, u16, PathBuf), HarnessError> {
    let short = std::env::temp_dir().join(format!("bsr-ssh-{}", std::process::id()));
    std::fs::create_dir_all(&short)?;
    let mut children = Children(Vec::new(), short.clone());
    let fixture = home.join("sshd");
    std::fs::create_dir_all(&fixture)?;
    let host_key = fixture.join("host_key");
    run(Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&host_key))?;
    std::fs::copy(key.with_extension("pub"), fixture.join("authorized_keys"))?;
    let port = std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port();
    let config = fixture.join("sshd_config");
    std::fs::write(
        &config,
        format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nAuthorizedKeysFile {}\n\
             PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n\
             StrictModes no\nPidFile {}\n",
            host_key.display(),
            fixture.join("authorized_keys").display(),
            fixture.join("sshd.pid").display(),
        ),
    )?;
    let log = std::fs::File::create(fixture.join("sshd.log"))?;
    children.0.push(
        Command::new("/usr/sbin/sshd")
            .arg("-D")
            .arg("-f")
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?,
    );
    wait_for("sshd", || {
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
    })?;
    let host = std::fs::read_to_string(host_key.with_extension("pub"))?;
    let host: Vec<_> = host.split_whitespace().take(2).collect();
    std::fs::write(
        home.join(".ssh/known_hosts"),
        format!("[127.0.0.1]:{port} {}\n", host.join(" ")),
    )?;
    let socket = short.join("agent.sock");
    children.0.push(
        Command::new("ssh-agent")
            .arg("-D")
            .arg("-a")
            .arg(&socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?,
    );
    wait_for("ssh-agent", || socket.exists())?;
    run(Command::new("ssh-add")
        .arg("-q")
        .arg(key)
        .env("SSH_AUTH_SOCK", &socket))?;
    Ok((children, port, socket))
}

fn git(directory: &Path, arguments: &[&str]) -> Result<String, HarnessError> {
    run(Command::new("git")
        .args([
            "-c",
            "user.name=Butler E2E",
            "-c",
            "user.email=e2e@example.invalid",
        ])
        .args(arguments)
        .current_dir(directory))
}

#[tokio::test]
async fn git_over_ssh_authenticates_through_the_agent_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::secret_reads_deniable(),
        "Requires kernel credential-read denial for approved commands"
    );
    let (url, script, server) = super::stub::start().await?;
    let setup = Setup::new("PERM-SECRETS-SSH")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let home = setup.sandbox.home.clone();
    std::fs::create_dir_all(home.join(".ssh"))?;
    let key = home.join(".ssh/id_ed25519");
    run(Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key))?;
    let (_children, port, socket) = servers(&home, &key)?;
    let remote = home.join("remote.git");
    run(Command::new("git")
        .args(["init", "-q", "--bare"])
        .arg(&remote))?;
    let folder = home.join("proj");
    std::fs::create_dir_all(&folder)?;
    let setup = setup.env("SSH_AUTH_SOCK", socket.to_string_lossy());
    let mut s = setup.start().await?;
    let chat = super::super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::create_dir_all(&project)?;
    std::fs::write(
        project.join("ssh_config"),
        format!(
            "Host butler-e2e\n  HostName 127.0.0.1\n  Port {port}\n  User {}\n  \
             UserKnownHostsFile {}\n  IdentityFile {}\n  BatchMode yes\n  \
             StrictHostKeyChecking yes\n",
            run(Command::new("id").arg("-un"))?,
            home.join(".ssh/known_hosts").display(),
            key.display(),
        ),
    )?;
    git(&project, &["init", "-q"])?;
    std::fs::write(project.join("note.txt"), "pushed over ssh")?;
    git(&project, &["add", "note.txt"])?;
    git(&project, &["commit", "-q", "-m", "note"])?;
    let head = git(&project, &["rev-parse", "HEAD"])?;
    let push = format!(
        "GIT_SSH_COMMAND='ssh -F ssh_config' git push -q butler-e2e:{} HEAD:refs/heads/main",
        remote.display()
    );
    let output = approved(&s, &chat, &script, "push", &push).await?;
    assert!(output.contains("credential_reads_denied"), "{output}");
    let pushed = run(Command::new("git")
        .arg("--git-dir")
        .arg(&remote)
        .args(["rev-parse", "main"]))?;
    assert_eq!(pushed, head, "{output}");
    let read = r#"k=$(sed -n 's/^ *IdentityFile //p' ssh_config); cat "$k""#;
    let output = approved(&s, &chat, &script, "key", read).await?;
    assert!(!output.contains("PRIVATE KEY"), "{output}");
    assert!(output.contains("Operation not permitted"), "{output}");
    eprintln!("PERM-SECRETS ssh: push=agent key_file=unreadable");
    s.finish().await?;
    server.abort();
    Ok(())
}
