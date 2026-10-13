//! When an observation carries a screenshot. Text and refs are the default;
//! pixels come when the model asks to look, when the host finds the page
//! mostly visual (`auto`: decided from the page's structure, never by site),
//! or after a step whose result only pixels show.
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Pixels {
    /// Text and refs only.
    Never,
    /// The host attaches pixels when the page is mostly visual.
    Auto,
    /// Pixels are required; their absence is a refusal.
    Always,
}

impl Pixels {
    /// The host's `include_image` argument.
    pub(super) fn include(self) -> Value {
        match self {
            Self::Never => json!(false),
            Self::Auto => json!("auto"),
            Self::Always => json!(true),
        }
    }
}

/// What a browser call asks for: screenshots and close-ups always need
/// pixels; an observation follows its `look` (default `auto`).
pub(super) fn requested(name: &str, args: &Value, zoom: bool) -> Pixels {
    match name {
        "browser_screenshot" => Pixels::Always,
        "browser_observe" if zoom => Pixels::Always,
        "browser_observe" => match args["look"].as_str() {
            Some("never") => Pixels::Never,
            Some("always") => Pixels::Always,
            _ => Pixels::Auto,
        },
        _ => Pixels::Never,
    }
}

/// After a batch: steps aimed at screenshot points (canvas strokes, unlabeled
/// graphics) or drags change pixels the DOM does not describe.
pub(super) fn after_act(args: &Value, result: &Value) -> Pixels {
    let mut steps = args["steps"].as_array().into_iter().flatten();
    let pointed = steps.any(|step| {
        step.get("point").is_some()
            || step.get("target_point").is_some()
            || step["action"] == "drag"
    });
    let canvas = result["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|step| step["hit"]["role"] == "canvas");
    if pointed || canvas {
        Pixels::Always
    } else {
        Pixels::Auto
    }
}

/// What `requested` becomes on `model`: without vision an optional screenshot
/// is dropped, and `None` means pixels were required.
pub(super) async fn admitted(
    client: &super::client::Client,
    model: &str,
    requested: Pixels,
) -> Option<Pixels> {
    if requested == Pixels::Never || client.vision(model).await {
        return Some(requested);
    }
    (requested != Pixels::Always).then_some(Pixels::Never)
}
