//! `output.check` (P1b self-check) on the headless browser, the App's
//! `output-check.mjs`: the output loads in a fresh hidden page, is measured at
//! desktop and mobile size, and reports errors, blankness, overflow and
//! root-absolute paths, optionally with a screenshot.
use super::{
    Headless,
    hidden::{HiddenPage, Purpose},
    imaging,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

const CHECK: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/check.mjs");
const MOBILE: (u32, u32) = (390, 844);
const DESKTOP: (u32, u32) = (1280, 800);
const MAX_DIAGNOSTICS: usize = 1024;
const MAX_CHECKS: usize = 6;

/// Recent reports, for cursor pages and images (16, ten minutes).
#[derive(Default)]
pub(crate) struct Reports {
    entries: HashMap<String, (Value, String, Instant)>,
    order: Vec<String>,
    running: usize,
}

/// The App's `checkScript`: the template literal's text, unescaped.
fn check_script() -> Option<String> {
    let start = CHECK.find("checkScript = `")? + "checkScript = `".len();
    let end = CHECK[start..].find("`;")? + start;
    Some(CHECK[start..end].replace("\\\\", "\\"))
}

fn allowed(url: &str, origin: &str) -> bool {
    url::Url::parse(url)
        .is_ok_and(|u| u.origin().ascii_serialization() == origin && u.path().starts_with("/__o/"))
}

fn page_report(report: &Value, cursor: u64) -> Value {
    let total = report["errors"]["total"].as_u64().unwrap_or(0);
    if cursor > total {
        return json!({"status":"unknown","reason":"cursor_invalid"});
    }
    let shown: Vec<Value> = report["errors"]["shown"]
        .as_array()
        .into_iter()
        .flatten()
        .skip(usize::try_from(cursor).unwrap_or(usize::MAX))
        .take(5)
        .cloned()
        .collect();
    let mut result = report.clone();
    let next = cursor + shown.len() as u64;
    result["errors"] = json!({"total":total,"shown":shown});
    if next < total {
        result["next_cursor"] = json!(next);
    }
    result
}

async fn measure(hidden: &HiddenPage, mobile: bool) -> Result<Value, String> {
    let (width, height) = if mobile { MOBILE } else { DESKTOP };
    hidden
        .page
        .send(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":mobile}),
        )
        .await?;
    hidden
        .page
        .send(
            "Emulation.setTouchEmulationEnabled",
            json!({"enabled":mobile}),
        )
        .await?;
    let context = hidden
        .page
        .world(&hidden.page.session, &hidden.page.target)
        .await?;
    let script = check_script().ok_or("check_failed")?;
    hidden
        .page
        .evaluate_in(&hidden.page.session, context, &script)
        .await
}

impl Headless {
    /// One output check (`args`: url, revision, output_id, cursor,
    /// include_image, viewport), answered as the App's checker answers it.
    pub async fn output_check(
        self: &std::sync::Arc<Self>,
        args: &Value,
        content_origin: &str,
    ) -> Value {
        let url = args["url"].as_str().unwrap_or("").to_owned();
        let origin = url::Url::parse(&url)
            .map(|u| u.origin().ascii_serialization())
            .unwrap_or_default();
        if origin != content_origin
            || !allowed(&url, &origin)
            || !origin.starts_with("http://127.0.0.1:")
        {
            return json!({"status":"navigation_denied"});
        }
        let key = format!(
            "{}:{}",
            args["output_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&url),
            args["revision"].as_u64().unwrap_or(0)
        );
        let viewport = args["viewport"].as_str().unwrap_or("mobile").to_owned();
        if let Some(cursor) = args.get("cursor").filter(|c| !c.is_null()) {
            return self.cached(&key, cursor, args["include_image"] == true, &viewport);
        }
        if !self.enabled() {
            return json!({"status":"unavailable","reason":"no_browser"});
        }
        {
            let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
            if reports.running >= MAX_CHECKS {
                return json!({"status":"unknown","reason":"browser_busy"});
            }
            reports.running += 1;
        }
        let result = match tokio::time::timeout(
            Duration::from_millis(7500),
            self.check_once(&url, &origin, args, &viewport),
        )
        .await
        {
            Ok(Ok(report)) => report,
            Ok(Err(reason)) => reason,
            Err(_) => json!({"status":"unknown","reason":"check_failed"}),
        };
        let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        reports.running -= 1;
        if result["status"] == "ok" {
            if reports.order.len() >= 16 {
                let oldest = reports.order.remove(0);
                reports.entries.remove(&oldest);
            }
            reports.order.retain(|k| *k != key);
            reports.order.push(key.clone());
            reports
                .entries
                .insert(key, (result.clone(), viewport, Instant::now()));
            return page_report(&result, 0);
        }
        result
    }

    fn cached(&self, key: &str, cursor: &Value, image: bool, viewport: &str) -> Value {
        let reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        let Some((report, shot, at)) = reports
            .entries
            .get(key)
            .filter(|(_, _, at)| at.elapsed() < Duration::from_secs(600))
        else {
            return json!({"status":"unknown","reason":"cursor_expired"});
        };
        let _ = at;
        if image && (report.get("image").is_none() || shot != viewport) {
            return json!({"status":"unknown","reason":"image_unavailable"});
        }
        match cursor.as_u64() {
            Some(cursor) => page_report(report, cursor),
            None => json!({"status":"unknown","reason":"cursor_invalid"}),
        }
    }

    async fn check_once(
        self: &std::sync::Arc<Self>,
        url: &str,
        origin: &str,
        args: &Value,
        viewport: &str,
    ) -> Result<Value, Value> {
        let unknown = |reason: &str| json!({"status":"unknown","reason":reason});
        let browser = self.ready().await?;
        let hidden = HiddenPage::open(
            &browser,
            Purpose::Check {
                origin: origin.to_owned(),
            },
        )
        .await
        .map_err(|_| unknown("check_failed"))?;
        let result = run(&hidden, url, origin, args, viewport).await;
        hidden.close().await;
        result
    }
}

async fn run(
    hidden: &HiddenPage,
    url: &str,
    origin: &str,
    args: &Value,
    viewport: &str,
) -> Result<Value, Value> {
    let failed = |hidden: &HiddenPage| {
        let denied = hidden.diagnostics(|d| d.denied).unwrap_or(false);
        json!({"status":if denied {"navigation_denied"} else {"unknown"},"reason":"check_failed"})
    };
    let started = Instant::now();
    if hidden
        .navigate(url, Duration::from_millis(6000))
        .await
        .is_err()
    {
        return Err(failed(hidden));
    }
    let load_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let (Ok(desktop), Ok(mobile)) = (measure(hidden, false).await, measure(hidden, true).await)
    else {
        return Err(failed(hidden));
    };
    let current = hidden
        .page
        .send(
            "Target.getTargetInfo",
            json!({"targetId":hidden.page.target}),
        )
        .await
        .unwrap_or_default();
    let current_url = current["targetInfo"]["url"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let (denied, root, total, shown) = hidden
        .diagnostics(|d| (d.denied, d.root_absolute, d.total, d.shown.clone()))
        .unwrap_or_default();
    if denied || !allowed(&current_url, origin) {
        return Err(json!({"status":"navigation_denied"}));
    }
    if total > MAX_DIAGNOSTICS {
        return Err(
            json!({"status":"budget_exhausted","reason":"diagnostics_limit","errors":{"total":total,"shown":shown.iter().take(5).collect::<Vec<_>>()}}),
        );
    }
    let warnings = merged(&desktop, &mobile, root);
    let units: Vec<u16> = current["targetInfo"]["title"]
        .as_str()
        .unwrap_or("")
        .encode_utf16()
        .take(100)
        .collect();
    let title = String::from_utf16_lossy(&units)
        .trim_end_matches('\u{fffd}')
        .to_owned();
    let mut report = json!({"status":"ok","url":current_url,"load_ms":load_ms,"title":title,"errors":{"total":total,"shown":shown},
        "layout":{"blank":desktop["blank"] == true && mobile["blank"] == true,"overflow_px":{"desktop":desktop["overflow"],"mobile":mobile["overflow"]}},
        "warnings":warnings});
    if args["include_image"] == true {
        if viewport == "desktop" {
            measure(hidden, false).await.map_err(|_| failed(hidden))?;
        }
        report["image"] = shot(hidden).await;
    }
    Ok(report)
}

/// Both viewports' warnings once each, plus root-absolute paths the guard saw.
fn merged(desktop: &Value, mobile: &Value, root: bool) -> Vec<String> {
    let mut warnings: Vec<String> = Vec::new();
    for value in desktop["warnings"]
        .as_array()
        .into_iter()
        .chain(mobile["warnings"].as_array())
        .flatten()
    {
        if let Some(w) = value.as_str().filter(|w| !warnings.iter().any(|x| x == w)) {
            warnings.push(w.to_owned());
        }
    }
    if root && !warnings.iter().any(|w| w == "root_absolute_paths") {
        warnings.push("root_absolute_paths".into());
    }
    warnings
}

/// The viewport as a JPEG within the image carrier limit.
async fn shot(hidden: &HiddenPage) -> Value {
    let capture = json!({"format":"png","fromSurface":true,"captureBeyondViewport":false});
    let Some(shot) = hidden.page.capture(capture).await else {
        return json!({"error":"image_unavailable"});
    };
    match imaging::call(&hidden.page, "fit", &[imaging::png(&shot), json!(1024)]).await {
        Some(fitted) => json!({"mime_type":"image/jpeg","data":fitted["data"]}),
        None => json!({"error":"image_too_large"}),
    }
}

pub(crate) type SharedReports = Mutex<Reports>;
