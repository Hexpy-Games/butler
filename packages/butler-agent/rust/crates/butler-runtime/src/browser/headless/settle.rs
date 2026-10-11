//! Waiting for a page to settle after an action (the App executor's `settle`).
use super::page::Page;
use std::time::{Duration, Instant};

/// A request still open after this long is a stream or long poll, not a result.
const LONG_REQUEST: Duration = Duration::from_secs(5);

fn quiet(quiet_ms: u64, max_ms: u64) -> String {
    format!("new Promise(done=>{{let timer;const end=()=>{{observer.disconnect();clearTimeout(cap);done(true)}};
  const observer=new MutationObserver(()=>{{clearTimeout(timer);timer=setTimeout(end,{quiet_ms})}});
  observer.observe(document,{{subtree:true,childList:true,attributes:true,characterData:true}});
  timer=setTimeout(end,{quiet_ms});const cap=setTimeout(end,{max_ms})}})")
}

fn busy(page: &Page) -> bool {
    page.shared
        .with_tab(&page.tab, |t| {
            t.loading
                || t.requests
                    .values()
                    .any(|start| start.elapsed() < LONG_REQUEST)
        })
        .unwrap_or(false)
}

/// After an action, waits for loading, the page's own requests and DOM
/// updates to settle. Quiet pages return at once.
pub(crate) async fn settle(page: &Page, max: Duration) {
    let deadline = Instant::now() + max;
    for _ in 0..3 {
        if Instant::now() >= deadline {
            return;
        }
        while busy(page) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero()
            && let Ok(context) = page.world(&page.session, &page.target).await
        {
            let cap = u64::try_from(remaining.as_millis().min(2000)).unwrap_or(2000);
            let _ = page
                .evaluate_in(&page.session, context, &quiet(300, cap))
                .await;
        }
        if !busy(page) {
            return;
        }
    }
}
