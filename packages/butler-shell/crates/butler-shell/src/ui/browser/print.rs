use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow, bail};
use futures::future::{Either, select};
use gpui::{AsyncApp, px, size};
use serde_json::{Value, json};

use super::engine::{Profile, TabId};
use super::model::BrowserState;
use crate::ui::source::fetch::sleep;

const ASSETS_READY: &str = concat!(
    "Promise.all(Array.from(document.images, i => i.decode().catch(() => null)))",
    ".then(() => document.fonts.ready).then(() => true)"
);

pub(crate) async fn pdf(html: String, cx: &mut AsyncApp) -> Result<Vec<u8>> {
    let start = Instant::now();
    let tab = cx.update_global::<BrowserState, _>(|state, cx| {
        state.start_engine(cx);
        let engine = &mut state.engine;
        if !engine.supports_devtools() {
            bail!("PDF printing requires DevTools");
        }
        let tab = TabId(format!("document-print-{}", uuid::Uuid::new_v4()).into());
        engine.open(
            &tab,
            "about:blank",
            Profile::SignedOut,
            "document-print",
            "document-print",
        );
        engine.keep_awake(&tab, true);
        engine.resize(&tab, size(px(800.), px(600.)), 1.);
        Ok(tab)
    })?;
    let result = {
        let timeout = async {
            loop {
                sleep(cx, Duration::from_secs(1)).await;
                if start.elapsed() >= Duration::from_secs(60) {
                    break;
                }
            }
        };
        match select(Box::pin(print_page(&tab, &html, cx)), Box::pin(timeout)).await {
            Either::Left((result, _)) => result,
            Either::Right(_) => Err(anyhow!("PDF printing timed out")),
        }
    };
    cx.update_global::<BrowserState, _>(|state, _| {
        state.engine.keep_awake(&tab, false);
        state.engine.close(&tab);
    });
    result
}

async fn call(tab: &TabId, method: &str, params: Value, cx: &AsyncApp) -> Result<Value> {
    let reply = cx.update_global::<BrowserState, _>(move |state, _| {
        state.engine.devtools(tab, method, &params)
    });
    reply.await.context("DevTools reply cancelled")?
}

async fn wait_until_ready(tab: &TabId, cx: &AsyncApp) -> Result<()> {
    let start = Instant::now();
    let ready = async {
        loop {
            let reply = call(
                tab,
                "Runtime.evaluate",
                json!({
                    "expression": "document.readyState",
                    "returnByValue": true,
                }),
                cx,
            )
            .await;
            if reply.is_ok_and(|reply| reply["result"]["value"] == "complete") {
                break;
            }
            sleep(cx, Duration::from_millis(50)).await;
        }
    };
    let timeout = async {
        while let Some(left) = Duration::from_secs(10).checked_sub(start.elapsed()) {
            sleep(cx, left).await;
        }
    };
    if matches!(
        select(Box::pin(ready), Box::pin(timeout)).await,
        Either::Right(_)
    ) {
        bail!("Print page did not become ready");
    }
    Ok(())
}

async fn assets_ready(tab: &TabId, cx: &AsyncApp) -> Result<()> {
    let reply = call(
        tab,
        "Runtime.evaluate",
        json!({
            "expression": ASSETS_READY,
            "awaitPromise": true,
            "returnByValue": true,
        }),
        cx,
    )
    .await?;
    anyhow::ensure!(
        reply["result"]["value"] == true,
        "Print assets did not become ready"
    );
    Ok(())
}

async fn print_page(tab: &TabId, html: &str, cx: &AsyncApp) -> Result<Vec<u8>> {
    wait_until_ready(tab, cx).await?;
    let tree = call(tab, "Page.getFrameTree", json!({}), cx).await?;
    let frame = tree["frameTree"]["frame"]["id"]
        .as_str()
        .context("No print frame")?;
    call(
        tab,
        "Emulation.setScriptExecutionDisabled",
        json!({"value": true}),
        cx,
    )
    .await?;
    call(
        tab,
        "Page.setDocumentContent",
        json!({"frameId": frame, "html": html}),
        cx,
    )
    .await?;
    if assets_ready(tab, cx).await.is_err() {
        sleep(cx, Duration::from_millis(50)).await;
        let _ = assets_ready(tab, cx).await;
    }
    let reply = call(
        tab,
        "Page.printToPDF",
        json!({
            "printBackground": true,
            "preferCSSPageSize": true,
            "generateTaggedPDF": false,
            "generateDocumentOutline": false,
        }),
        cx,
    )
    .await?;
    reply["data"]
        .as_str()
        .and_then(decode)
        .context("Invalid PDF data")
}

fn decode(data: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(data.len() / 4 * 3);
    let mut chunks = data.as_bytes().chunks(4).peekable();
    while let Some(chunk) = chunks.next() {
        let [a, b, c, d] = *chunk else {
            return None;
        };
        let digit = |c| match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        };
        let b = digit(b)?;
        bytes.push(digit(a)? << 2 | b >> 4);
        if c != b'=' {
            let c = digit(c)?;
            bytes.push(b << 4 | c >> 2);
            if d != b'=' {
                bytes.push(c << 6 | digit(d)?);
            }
        } else if d != b'=' {
            return None;
        }
        if d == b'=' && chunks.peek().is_some() {
            return None;
        }
    }
    Some(bytes)
}
