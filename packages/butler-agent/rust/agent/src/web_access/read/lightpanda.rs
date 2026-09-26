use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::{
    fs::File as TokioFile,
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::web_access::{
    page::{PageRead, extract_page},
    service::{WebAccess, WebAccessError},
    spool::{FetchedBody, TemporarySpool},
};

const MAX_RUNTIME: Duration = Duration::from_secs(20);
const DEFAULT_WAIT_MS: u64 = 5_000;
const LIGHTPANDA_PATHS: [&str; 3] = [
    "/opt/homebrew/bin/lightpanda",
    "/usr/local/bin/lightpanda",
    "/usr/bin/lightpanda",
];

pub(super) async fn render(
    access: &WebAccess,
    url: &Url,
    requested_url: &str,
    cancellation: &CancellationToken,
) -> Result<Option<PageRead>, WebAccessError> {
    let Some(binary) = resolve_binary(access)? else {
        return Ok(None);
    };
    let wait_ms = access
        .environment_value("BUTLER_LIGHTPANDA_WAIT_MS")?
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_WAIT_MS)
        .min(MAX_RUNTIME.as_millis().saturating_sub(1_000) as u64)
        .max(500);
    let fetched = match run_dump(access, &binary, url, wait_ms, cancellation).await {
        Ok(fetched) => fetched,
        Err(error) if error.code == "cancelled" => return Err(error),
        Err(_) => {
            return Ok(Some(render_failed(
                requested_url,
                "Lightpanda render failed.",
            )));
        }
    };
    let status = fetched.status;
    let ok = fetched.ok;
    let content_type = fetched.content_type.clone();
    let requested = requested_url.to_owned();
    let final_url = url.to_string();
    let mut page = tokio::task::spawn_blocking(move || {
        let bytes = fetched.read_all().map_err(|_| {
            WebAccessError::new(
                "web_access_spool_failed",
                "Rendered page could not be read.",
            )
        })?;
        extract_page(
            &requested,
            &final_url,
            status,
            ok,
            content_type.as_deref(),
            &bytes,
            "lightpanda",
        )
    })
    .await
    .map_err(|_| {
        WebAccessError::new(
            "web_read_parse_failed",
            "Rendered page could not be parsed.",
        )
    })??;
    page.reader = "lightpanda".into();
    if !page
        .warnings
        .iter()
        .any(|warning| warning == "lightpanda-rendered-fallback-used")
    {
        page.warnings
            .push("lightpanda-rendered-fallback-used".into());
        page.warnings.sort();
    }
    Ok(Some(page))
}

fn resolve_binary(access: &WebAccess) -> Result<Option<PathBuf>, WebAccessError> {
    for name in ["BUTLER_LIGHTPANDA_BIN", "LIGHTPANDA_BIN"] {
        if let Some(value) = access.environment_value(name)? {
            let path = PathBuf::from(value);
            return Ok(executable_path(&path).then_some(path));
        }
    }
    Ok(LIGHTPANDA_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|path| executable_path(path)))
}

fn executable_path(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| {
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            true
        }
    })
}

async fn run_dump(
    access: &WebAccess,
    binary: &Path,
    url: &Url,
    wait_ms: u64,
    cancellation: &CancellationToken,
) -> Result<FetchedBody, WebAccessError> {
    if cancellation.is_cancelled() {
        return Err(WebAccessError::cancelled());
    }
    let mut child = Command::new(binary)
        .args([
            "fetch",
            "--dump",
            "html",
            "--log-format",
            "pretty",
            "--log-level",
            "warn",
        ])
        .arg("--wait-ms")
        .arg(wait_ms.to_string())
        .arg(url.as_str())
        .env("LIGHTPANDA_DISABLE_TELEMETRY", "true")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            WebAccessError::new(
                "web_access_reader_unavailable",
                "Lightpanda is unavailable.",
            )
        })?;
    let Some(mut stdout) = child.stdout.take() else {
        stop_child(&mut child).await;
        return Err(WebAccessError::new(
            "web_access_reader_unavailable",
            "Lightpanda output is unavailable.",
        ));
    };
    let mut spool = match TemporarySpool::create(access.data_root()) {
        Ok(spool) => spool,
        Err(_) => {
            stop_child(&mut child).await;
            return Err(WebAccessError::new(
                "web_access_spool_failed",
                "Rendered page could not be spooled in DATA.",
            ));
        }
    };
    let mut file = TokioFile::from_std(spool.open_file.take().expect("new private spool"));
    let deadline = Instant::now() + MAX_RUNTIME;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = tokio::select! {
            biased;
            _ = cancellation.cancelled() => { stop_child(&mut child).await; return Err(WebAccessError::cancelled()); }
            _ = tokio::time::sleep_until(deadline) => { stop_child(&mut child).await; return Err(WebAccessError::new("web_access_reader_timeout", "Lightpanda timed out.")); }
            result = stdout.read(&mut buffer) => match result {
                Ok(read) => read,
                Err(_) => { stop_child(&mut child).await; return Err(WebAccessError::new("web_access_reader_failed", "Lightpanda output failed.")); }
            },
        };
        if read == 0 {
            break;
        }
        if file.write_all(&buffer[..read]).await.is_err() {
            stop_child(&mut child).await;
            return Err(WebAccessError::new(
                "web_access_spool_failed",
                "Rendered page could not be spooled in DATA.",
            ));
        }
    }
    drop(stdout);
    let status = tokio::select! {
        biased;
        _ = cancellation.cancelled() => { stop_child(&mut child).await; return Err(WebAccessError::cancelled()); }
        _ = tokio::time::sleep_until(deadline) => { stop_child(&mut child).await; return Err(WebAccessError::new("web_access_reader_timeout", "Lightpanda timed out.")); }
        status = child.wait() => status.map_err(|_| WebAccessError::new("web_access_reader_failed", "Lightpanda process failed."))?,
    };
    if file.flush().await.is_err() {
        return Err(WebAccessError::new(
            "web_access_spool_failed",
            "Rendered page could not be spooled in DATA.",
        ));
    }
    drop(file);
    if !status.success() {
        return Err(WebAccessError::new(
            "web_access_reader_failed",
            "Lightpanda process failed.",
        ));
    }
    Ok(FetchedBody {
        final_url: url.to_string(),
        status: 200,
        ok: true,
        content_type: Some("text/html; charset=utf-8".into()),
        spool,
    })
}

async fn stop_child(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn render_failed(requested_url: &str, message: &str) -> PageRead {
    let mut page = PageRead::unavailable(
        requested_url,
        requested_url,
        "lightpanda",
        message,
        "lightpanda-render-failed",
    );
    page.render_recommended = true;
    page
}
