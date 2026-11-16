//! Electron's reader is the single source of truth. Only the module export keyword is stripped:
//! the function and its comments are otherwise passed unchanged into the isolated context.
use crate::ui::browser::{engine::TabId, model::BrowserState};
use gpui::AsyncApp;
use serde_json::{Value, json};

const SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../butler-app/client/electron/browser/pick-page.mjs"
));

fn source() -> &'static str {
    static READER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    READER.get_or_init(|| SOURCE.replacen("export ", "", 1))
}

pub(super) async fn protocol(
    page: &TabId,
    method: &str,
    params: Value,
    cx: &AsyncApp,
) -> anyhow::Result<Value> {
    let reply = cx.update(|cx| {
        cx.global::<BrowserState>()
            .engine
            .devtools(page, method, &params)
    });
    reply.await?
}

pub(super) async fn run(
    page: &TabId,
    path: &[usize],
    mut args: Value,
    cx: &AsyncApp,
) -> anyhow::Result<Value> {
    args["token"] = json!(uuid::Uuid::new_v4().to_string());
    let source = source();
    evaluate(page, path, format!("{source}\npickPage({args})"), cx).await
}

pub(super) async fn begin(
    page: &TabId,
    path: &[usize],
    mut args: Value,
    cx: &AsyncApp,
) -> anyhow::Result<crate::ui::browser::engine::DevToolsReply> {
    args["token"] = json!(uuid::Uuid::new_v4().to_string());
    let source = source();
    request(page, path, format!("{source}\npickPage({args})"), cx).await
}
pub(super) async fn evaluate(
    page: &TabId,
    path: &[usize],
    expression: String,
    cx: &AsyncApp,
) -> anyhow::Result<Value> {
    decoded(&request(page, path, expression, cx).await?.await??)
}
pub(super) fn decoded(value: &Value) -> anyhow::Result<Value> {
    if value.get("exceptionDetails").is_some() {
        anyhow::bail!("pick reader failed");
    }
    Ok(value["result"]["value"].clone())
}
async fn request(
    page: &TabId,
    path: &[usize],
    expression: String,
    cx: &AsyncApp,
) -> anyhow::Result<crate::ui::browser::engine::DevToolsReply> {
    let session = cx
        .update(|cx| {
            cx.global::<BrowserState>()
                .tab(page)
                .map(|t| t.pick.clone())
        })
        .ok_or_else(|| anyhow::anyhow!("page closed"))?;
    let generation = session.generation.get();
    let cached = session.worlds.borrow().get(path).copied();
    let context = if let Some(context) = cached {
        context
    } else {
        let tree = protocol(page, "Page.getFrameTree", json!({}), cx).await?;
        let mut frame = &tree["frameTree"];
        for index in path {
            frame = frame
                .get("childFrames")
                .and_then(|v| v.get(index))
                .ok_or_else(|| anyhow::anyhow!("frame gone"))?;
        }
        let world = protocol(
            page,
            "Page.createIsolatedWorld",
            json!({
                "frameId": frame["frame"]["id"], "worldName": "butler-pick",
            }),
            cx,
        )
        .await?;
        let context = world["executionContextId"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("missing isolated world"))?;
        anyhow::ensure!(session.generation.get() == generation, "document changed");
        session.worlds.borrow_mut().insert(path.to_vec(), context);
        if let Some(id) = frame["frame"]["id"].as_str() {
            session
                .frames
                .borrow_mut()
                .insert(path.to_vec(), id.to_owned());
        }
        context
    };
    let params = json!({"contextId":context,"expression":expression,"returnByValue":true,"awaitPromise":true});
    Ok(cx.update(|cx| {
        cx.global::<BrowserState>()
            .engine
            .devtools(page, "Runtime.evaluate", &params)
    }))
}
