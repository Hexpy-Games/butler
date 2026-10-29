//! Source image bytes fetched through the observed tab's network session.
use super::{capture, collect_crop, page::Page, scripts::scripts};
use serde_json::{Value, json};
const SOURCE: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/collect-image.mjs");
const RENDITIONS: &str = include_str!(
    "../../../../../../../butler-app/client/electron/browser/page/image-renditions.mjs"
);

fn source_script(args: &Value) -> String {
    let source = SOURCE
        .split("/** Isolated-world script")
        .next()
        .unwrap_or(SOURCE)
        .lines()
        .filter(|line| !line.starts_with("import "))
        .collect::<Vec<_>>()
        .join("\n")
        .replace("export ", "");
    let renditions = RENDITIONS.replace("export ", "");
    format!("(() => {{ {renditions} {source} return imageSource({args}); }})()")
}

pub(crate) async fn collect(page: &Page, args: &Value) -> Result<Value, String> {
    let epoch = page.epoch().ok_or("tab_closed")?;
    if args["url"].is_string() {
        return url_source(page, args, epoch).await;
    }
    let observation = page
        .shared
        .with_tab(&page.tab, |t| t.observation.clone())
        .flatten()
        .ok_or("stale_ref")?;
    let mut args = args.clone();
    if args["observation"].is_null() {
        args["observation"] = json!(observation.obs);
    }
    if observation.epoch != epoch || args["observation"] != observation.obs {
        return Ok(json!({"status":"refused","reason":"stale_ref"}));
    }
    if args["region"].is_array() {
        return collect_crop::capture(page, &args, epoch).await;
    }
    let frame = if let Some(reference) = args["ref"].as_str() {
        observation.frame_of(reference).ok_or("stale_ref")?
    } else {
        observation.frames.first().ok_or("frame_unavailable")?
    };
    // An image's own pixels or file do not depend on what covers it on the page;
    // only a rendered crop needs the element to be the unobstructed target.
    let source = page
        .evaluate(
            frame,
            &source_script(&json!({"ref":args["ref"],"url":args["url"],"obs":args["observation"],"epoch":epoch})),
        )
        .await?;
    if source["reason"].is_string() {
        return Ok(
            json!({"status":"refused","reason":source["reason"],"recovery":source["recovery"]}),
        );
    }
    if source["image"].is_object() {
        if page.epoch() != Some(epoch) {
            return Err("control_changed".into());
        }
        let mut result = source;
        result["status"] = json!("ok");
        return Ok(result);
    }
    fallback_capture(page, frame, &args, epoch, source).await
}

async fn fallback_capture(
    page: &Page,
    frame: &super::state::Frame,
    args: &Value,
    epoch: u64,
    source: Value,
) -> Result<Value, String> {
    let original = source["fetch_source"] == true;
    let described = |mut result: Value| {
        for key in ["alt", "nearby_text", "source_url"] {
            result[key] = source[key].clone();
        }
        if original {
            for key in ["fetch_source", "referer", "user_agent"] {
                result[key] = source[key].clone();
            }
        }
        result
    };
    if let Some(refused) = check_ref(page, frame, args, epoch).await? {
        return Ok(if original {
            described(json!({"status":"ok"}))
        } else {
            refused
        });
    }
    let crop = capture::screenshot(page, args).await?;
    if crop["status"] != "ok" && original {
        return Ok(described(json!({"status":"ok"})));
    }
    Ok(described(crop))
}

async fn check_ref(
    page: &Page,
    frame: &super::state::Frame,
    args: &Value,
    epoch: u64,
) -> Result<Option<Value>, String> {
    if args["ref"].is_string() {
        let resolved = page
            .evaluate(
                frame,
                &scripts()
                    .ok_or("scripts_unavailable")?
                    .resolve(&json!({"ref":args["ref"],"obs":args["observation"],"epoch":epoch})),
            )
            .await?;
        if resolved["reason"].is_string() {
            return Ok(Some(
                json!({"status":"refused","reason":resolved["reason"]}),
            ));
        }
    }
    Ok(None)
}

async fn url_source(page: &Page, args: &Value, epoch: u64) -> Result<Value, String> {
    let frames = page.frame_worlds().await?;
    let frame = frames.first().ok_or("frame_unavailable")?;
    let mut source = page
        .evaluate(frame, &source_script(&json!({"url":args["url"]})))
        .await?;
    if page.epoch() != Some(epoch) {
        return Err("control_changed".into());
    }
    source["status"] = json!(if source["reason"].is_string() {
        "refused"
    } else {
        "ok"
    });
    Ok(source)
}
