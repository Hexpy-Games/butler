//! The pinned Chrome for Testing headless shell, installed on first use.
//!
//! The manifest below is compiled into the Butler binary, so it carries the
//! Butler release's own code signature; nothing is read from the network to
//! decide what to trust. Each archive is checked against its pinned size and
//! SHA-256 before it is unpacked, and the executable is checked against its
//! pinned SHA-256 after unpacking and again before every launch. A file that
//! fails a check is deleted and never run.
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::watch};

pub(crate) const VERSION: &str = "155.0.8059.39";
const DEFAULT_BASE: &str = "https://storage.googleapis.com/chrome-for-testing-public";

struct Artifact {
    platform: &'static str,
    size: u64,
    sha256: &'static str,
    executable_sha256: &'static str,
}

const ARTIFACTS: &[Artifact] = &[
    Artifact {
        platform: "mac-arm64",
        size: 102_429_510,
        sha256: "b3e093c06001c41e68decbc8dd4a62f9efe4bf4e4dd247a686ea531863448d75",
        executable_sha256: "93039c9fbd18302515c40f1d9d147967402ac67aa0e81b44c623f889315d9285",
    },
    Artifact {
        platform: "mac-x64",
        size: 107_758_350,
        sha256: "6338a784c691f42dd1ed6aeeef650171c7d72cf74bdb8450d0079864e72a8074",
        executable_sha256: "9e4becd4215f4ba236b87a0c6168fcddf5d1516006af6250b52a5f1ecec22e82",
    },
    Artifact {
        platform: "linux64",
        size: 124_203_329,
        sha256: "39dcb8c46550632a3d911850ab3b8af840b4e3f6d8622faa2018eb8756278786",
        executable_sha256: "d8f762c0153b944bc0cd747fa6ae2e0497d29d703049833e2942e15fc646b82b",
    },
    Artifact {
        platform: "linux-arm64",
        size: 124_553_121,
        sha256: "9fb86f7c0b2734c5febc0bbb4e85f37da43553f3f8a7970949828c5713e87e94",
        executable_sha256: "cf71e098238f71bc1415a424c71ebd56b6cedb5c18f8db5e749405937681dd76",
    },
    Artifact {
        platform: "win64",
        size: 124_737_213,
        sha256: "20798f7c51a22def0b3d02e526a8f52e7ee2c7eddcde9d81a4c23f618e8b5436",
        executable_sha256: "cb3e6c88734823d828042d9a153ca9c8f5989301456d4fcda76079a88c475791",
    },
];

/// Where installs live and where archives come from.
#[derive(Clone, Debug)]
pub struct InstallSource {
    /// Holds `chrome-for-testing/<version>/<platform>/`.
    pub cache_root: PathBuf,
    /// Archive host; pinned hashes apply whatever the host.
    pub base_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Progress {
    Running { received: u64, total: u64 },
    Ready(PathBuf),
    Failed(&'static str),
}

pub(crate) struct Installer {
    source: InstallSource,
    state: Mutex<Option<watch::Receiver<Progress>>>,
}

fn artifact() -> Option<&'static Artifact> {
    let platform = butler_platform::browser_process::chrome_for_testing_platform()?;
    ARTIFACTS.iter().find(|a| a.platform == platform)
}

impl Installer {
    pub(crate) fn new(source: InstallSource) -> Arc<Self> {
        Arc::new(Self {
            source,
            state: Mutex::new(None),
        })
    }

    fn directory(&self, artifact: &Artifact) -> PathBuf {
        self.source
            .cache_root
            .join("chrome-for-testing")
            .join(VERSION)
            .join(artifact.platform)
    }

    fn executable(&self, artifact: &Artifact) -> PathBuf {
        self.directory(artifact)
            .join(format!("chrome-headless-shell-{}", artifact.platform))
            .join(butler_platform::browser_process::HEADLESS_SHELL_EXECUTABLE)
    }

    /// The verified executable, installing it first when missing. Waits at
    /// most `wait`; an install still running then reports its progress.
    pub(crate) async fn executable_within(self: &Arc<Self>, wait: Duration) -> Progress {
        let Some(artifact) = artifact() else {
            return Progress::Failed("browser_platform_unsupported");
        };
        let executable = self.executable(artifact);
        if executable.is_file() {
            let path = executable.clone();
            let verified = tokio::task::spawn_blocking(move || {
                file_sha256(&path).is_ok_and(|digest| digest == artifact.executable_sha256)
            })
            .await
            .unwrap_or(false);
            if verified {
                return Progress::Ready(executable);
            }
            // A changed executable is never run; reinstall from the archive.
            let _ = std::fs::remove_dir_all(self.directory(artifact));
        }
        let mut receiver = self.begin(artifact);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let current = receiver.borrow_and_update().clone();
            if matches!(current, Progress::Ready(_) | Progress::Failed(_)) {
                return current;
            }
            if tokio::time::timeout_at(deadline, receiver.changed())
                .await
                .map_or(true, |changed| changed.is_err())
            {
                return receiver.borrow().clone();
            }
        }
    }

    fn begin(self: &Arc<Self>, artifact: &'static Artifact) -> watch::Receiver<Progress> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(receiver) = state.as_ref()
            && matches!(*receiver.borrow(), Progress::Running { .. })
        {
            return receiver.clone();
        }
        let (sender, receiver) = watch::channel(Progress::Running {
            received: 0,
            total: artifact.size,
        });
        *state = Some(receiver.clone());
        let installer = self.clone();
        eprintln!(
            "INFO [browser] installing Chrome for Testing headless shell {VERSION} ({}, {} bytes) for headless browsing",
            artifact.platform, artifact.size
        );
        tokio::spawn(async move {
            let result = installer.install(artifact, &sender).await;
            match &result {
                Progress::Ready(_) => {
                    eprintln!("INFO [browser] headless shell {VERSION} installed");
                }
                Progress::Failed(reason) => {
                    eprintln!("WARN [browser] headless shell install failed: {reason}");
                }
                Progress::Running { .. } => {}
            }
            let _ = sender.send(result);
        });
        receiver
    }

    async fn install(
        &self,
        artifact: &'static Artifact,
        progress: &watch::Sender<Progress>,
    ) -> Progress {
        let directory = self.directory(artifact);
        let Some(parent) = directory.parent() else {
            return Progress::Failed("browser_install_failed");
        };
        if std::fs::create_dir_all(parent).is_err() {
            return Progress::Failed("browser_install_failed");
        }
        let token = uuid::Uuid::new_v4();
        let archive = parent.join(format!(".download-{token}.zip"));
        let staging = parent.join(format!(".staging-{token}"));
        let mut result = self.download(artifact, &archive, progress).await;
        if result.is_ok() {
            result = unpack(archive.clone(), staging.clone(), artifact).await;
        }
        if result.is_ok() {
            result = std::fs::rename(&staging, &directory).map_err(|_| "browser_install_failed");
        }
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_dir_all(&staging);
        match result {
            Ok(()) => Progress::Ready(self.executable(artifact)),
            Err(reason) => Progress::Failed(reason),
        }
    }

    async fn download(
        &self,
        artifact: &Artifact,
        archive: &Path,
        progress: &watch::Sender<Progress>,
    ) -> Result<(), &'static str> {
        let base = self.source.base_url.as_deref().unwrap_or(DEFAULT_BASE);
        let platform = artifact.platform;
        let url = format!(
            "{}/{VERSION}/{platform}/chrome-headless-shell-{platform}.zip",
            base.trim_end_matches('/')
        );
        let response = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "browser_download_failed")?
            .get(url)
            .send()
            .await
            .map_err(|_| "browser_download_failed")?;
        if !response.status().is_success() {
            return Err("browser_download_failed");
        }
        let mut file = tokio::fs::File::create(archive)
            .await
            .map_err(|_| "browser_install_failed")?;
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "browser_download_failed")?;
            received += chunk.len() as u64;
            if received > artifact.size {
                return Err("browser_download_verification_failed");
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| "browser_install_failed")?;
            let _ = progress.send(Progress::Running {
                received,
                total: artifact.size,
            });
        }
        file.flush().await.map_err(|_| "browser_install_failed")?;
        if received != artifact.size || hex(&hasher.finalize()) != artifact.sha256 {
            return Err("browser_download_verification_failed");
        }
        Ok(())
    }
}

async fn unpack(
    archive: PathBuf,
    staging: PathBuf,
    artifact: &'static Artifact,
) -> Result<(), &'static str> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive).map_err(|_| "browser_install_failed")?;
        let mut zip = zip::ZipArchive::new(file).map_err(|_| "browser_install_failed")?;
        zip.extract(&staging)
            .map_err(|_| "browser_install_failed")?;
        let executable = staging
            .join(format!("chrome-headless-shell-{}", artifact.platform))
            .join(butler_platform::browser_process::HEADLESS_SHELL_EXECUTABLE);
        if file_sha256(&executable).ok().as_deref() != Some(artifact.executable_sha256) {
            return Err("browser_download_verification_failed");
        }
        if let Some(Err(_)) = butler_platform::launcher::mark_executable(&executable) {
            return Err("browser_install_failed");
        }
        Ok(())
    })
    .await
    .map_err(|_| "browser_install_failed")?
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}
