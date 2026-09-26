use std::time::{Duration, Instant};

use reqwest::Url;
use tokio_util::sync::CancellationToken;

use crate::web_access::{
    page::{PageRead, extract_page},
    service::{WebAccess, WebAccessError},
    spool::FetchedBody,
};

const ACCEPT_PAGE: &str =
    "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.8,*/*;q=0.5";

impl WebAccess {
    pub(in crate::web_access) async fn read_page(
        &self,
        url: Url,
        requested_url: &str,
        backend: &str,
        cancellation: &CancellationToken,
    ) -> Result<PageRead, WebAccessError> {
        let budget = cancellation.child_token();
        let task_budget = budget.clone();
        let access = self.clone();
        let url_for_task = url.clone();
        let requested_for_task = requested_url.to_owned();
        let backend_for_task = backend.to_owned();
        let mut task = tokio::spawn(async move {
            access
                .read_page_with_budget(
                    url_for_task,
                    &requested_for_task,
                    &backend_for_task,
                    &task_budget,
                )
                .await
        });
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                budget.cancel();
                cancel_and_reap(&mut task).await;
                Err(WebAccessError::cancelled())
            }
            output = &mut task => output.map_err(|_| {
                WebAccessError::new("web_read_failed", "Public page read failed.")
            })?,
            () = tokio::time::sleep(Duration::from_secs(20)) => {
                budget.cancel();
                cancel_and_reap(&mut task).await;
                Ok(timeout_page(requested_url))
            }
        }
    }

    async fn read_page_with_budget(
        &self,
        url: Url,
        requested_url: &str,
        backend: &str,
        cancellation: &CancellationToken,
    ) -> Result<PageRead, WebAccessError> {
        let started = Instant::now();
        if backend == "disabled" {
            return Ok(PageRead::unavailable(
                requested_url,
                requested_url,
                "disabled",
                "page reader backend is disabled",
                "page-reader-disabled",
            ));
        }
        let mut page =
            match lightweight(self, url.clone(), requested_url, backend, cancellation).await {
                Ok(page) => page,
                Err(error) if error.code == "cancelled" => return Err(error),
                Err(_) => failed_page(requested_url),
            };
        match backend {
            "jina-hosted" => add_warning(&mut page, "jina-hosted-reader-not-yet-enabled"),
            "auto" | "lightpanda" if page.render_recommended => {
                match super::lightpanda::render(self, &url, requested_url, cancellation).await {
                    Ok(Some(rendered)) if should_use_rendered(&page, &rendered) => {
                        page = rendered;
                    }
                    Ok(Some(rendered)) => {
                        add_warning(&mut page, &fallback_warning(&rendered));
                    }
                    Ok(None) => {
                        add_warning(&mut page, "lightpanda-unavailable-fell-back-to-lightweight");
                    }
                    Err(error) if error.code == "cancelled" => return Err(error),
                    Err(_) => add_warning(&mut page, "lightpanda-render-fallback-rejected"),
                }
            }
            _ => {}
        }
        page.duration_ms = u64::try_from(started.elapsed().as_millis().min(u128::from(u64::MAX)))
            .unwrap_or(u64::MAX);
        if cancellation.is_cancelled() {
            return Err(WebAccessError::cancelled());
        }
        Ok(page)
    }
}

async fn cancel_and_reap(task: &mut tokio::task::JoinHandle<Result<PageRead, WebAccessError>>) {
    if tokio::time::timeout(Duration::from_secs(1), &mut *task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}

async fn lightweight(
    access: &WebAccess,
    url: Url,
    requested_url: &str,
    backend: &str,
    cancellation: &CancellationToken,
) -> Result<PageRead, WebAccessError> {
    let (fetched, final_url) = access
        .fetch_page_to_spool(url.clone(), ACCEPT_PAGE, cancellation)
        .await?;
    let mut first = parse_fetched(
        fetched,
        requested_url.to_owned(),
        final_url.to_string(),
        backend.to_owned(),
    )
    .await?;
    if let Some(raw_url) = github_raw_url(&url)
        && should_retry_github_raw(&first)
    {
        let (raw, final_url) = access
            .fetch_page_to_spool(raw_url, ACCEPT_PAGE, cancellation)
            .await?;
        let candidate = parse_fetched(
            raw,
            requested_url.to_owned(),
            final_url.to_string(),
            backend.to_owned(),
        )
        .await?;
        if candidate.text.encode_utf16().count() > first.text.encode_utf16().count()
            || candidate.method == "github-raw"
        {
            first = candidate;
        }
    }
    Ok(first)
}

async fn parse_fetched(
    fetched: FetchedBody,
    requested_url: String,
    final_url: String,
    backend: String,
) -> Result<PageRead, WebAccessError> {
    let status = fetched.status;
    let ok = fetched.ok;
    let content_type = fetched.content_type.clone();
    tokio::task::spawn_blocking(move || {
        let bytes = fetched.read_all().map_err(|_| {
            WebAccessError::new("web_access_spool_failed", "Public page could not be read.")
        })?;
        extract_page(
            &requested_url,
            &final_url,
            status,
            ok,
            content_type.as_deref(),
            &bytes,
            &backend,
        )
    })
    .await
    .map_err(|_| WebAccessError::new("web_read_parse_failed", "Public page could not be parsed."))?
}

fn github_raw_url(url: &Url) -> Option<Url> {
    if url.host_str()? != "github.com" {
        return None;
    }
    let segments = url
        .path_segments()?
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if segments.get(2) != Some(&"blob") || segments.len() < 5 {
        return None;
    }
    let path = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        segments[0],
        segments[1],
        segments[3],
        segments[4..].join("/")
    );
    Url::parse(&path).ok()
}

fn should_retry_github_raw(page: &PageRead) -> bool {
    if matches!(page.method.as_str(), "pdf" | "unsupported" | "github-raw") {
        return false;
    }
    page.warnings
        .iter()
        .any(|warning| warning == "possible-login-or-block")
        || !["function", "const", "export", "import", "class", "=>"]
            .iter()
            .any(|marker| page.text.contains(marker))
}

fn failed_page(requested_url: &str) -> PageRead {
    let mut page = PageRead::unavailable(
        requested_url,
        requested_url,
        "butler-lightweight",
        "Public page request failed.",
        "page-read-failed",
    );
    page.warnings.clear();
    page.status = None;
    page.render_recommended = true;
    page
}

fn timeout_page(requested_url: &str) -> PageRead {
    let mut page = PageRead::unavailable(
        requested_url,
        requested_url,
        "butler-lightweight",
        "Page read timed out.",
        "page-read-timeout",
    );
    page.warnings.clear();
    page
}

fn add_warning(page: &mut PageRead, warning: &str) {
    if !page.warnings.iter().any(|value| value == warning) {
        page.warnings.push(warning.to_owned());
        page.warnings.sort();
    }
}

fn fallback_warning(rendered: &PageRead) -> String {
    if rendered.error.is_some() {
        "lightpanda-render-fallback-rejected:render-failed".into()
    } else {
        "lightpanda-render-fallback-rejected".into()
    }
}

fn should_use_rendered(lightweight: &PageRead, rendered: &PageRead) -> bool {
    if !rendered.ok || rendered.text.trim().is_empty() {
        return false;
    }
    let score = |page: &PageRead| {
        let mut score = if page.ok { 40_i32 } else { 0 };
        score +=
            i32::try_from((page.text.encode_utf16().count() / 100).min(40)).unwrap_or(i32::MAX);
        score += i32::try_from((page.chunks.len() * 3).min(15)).unwrap_or(i32::MAX);
        if page.method == "readability" {
            score += 8;
        }
        for (warning, penalty) in [
            ("cloudflare-challenge", 45),
            ("javascript-required", 30),
            ("likely-csr-app-shell", 30),
            ("possible-login-or-block", 20),
            ("tiny-content", 10),
        ] {
            if page.warnings.iter().any(|item| item == warning) {
                score -= penalty;
            }
        }
        score
    };
    let rendered_score = score(rendered);
    let lightweight_score = score(lightweight);
    rendered_score >= lightweight_score + 10
        || (lightweight
            .warnings
            .iter()
            .any(|value| value == "javascript-required")
            && rendered.text.encode_utf16().count() >= 500)
        || (lightweight
            .warnings
            .iter()
            .any(|value| value == "likely-csr-app-shell")
            && rendered.text.encode_utf16().count()
                >= lightweight.text.encode_utf16().count() * 3 / 2)
}
