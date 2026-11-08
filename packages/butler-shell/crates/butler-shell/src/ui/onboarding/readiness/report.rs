//! Copy info for a bug report (`copyReport`): the setup diagnostics with their labels and
//! reasons in the reader's language, and the readiness the screens show.
use butler_ds::ui::context::Lang;
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, ClipboardItem};
use serde_json::{Map, Value, json};

use super::ReadinessView;
use super::copy::{Words, words};

/// `localizeSetupDiagnostics`: a check's label from `prepSteps`, an error's message from
/// `prepReasons`.
fn localize(diagnostics: &mut Map<String, Value>, copy: &Words) {
    if let Some(checks) = diagnostics.get_mut("checks").and_then(Value::as_array_mut) {
        for check in checks.iter_mut().filter_map(Value::as_object_mut) {
            let id = check.get("id").and_then(Value::as_str).unwrap_or_default();
            let label = copy.step(id).unwrap_or(id).to_owned();
            check.insert("label".into(), Value::from(label));
        }
    }
    if let Some(errors) = diagnostics.get_mut("errors").and_then(Value::as_array_mut) {
        for error in errors.iter_mut().filter_map(Value::as_object_mut) {
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let message = copy.reason(code);
            error.insert("message".into(), Value::from(message));
        }
    }
}

/// The readiness the screens show, as JSON.
fn readiness_json(view: &ReadinessView) -> Value {
    let steps: Vec<Value> = view
        .steps
        .iter()
        .map(|(id, status)| json!({ "id": &**id, "status": &**status }))
        .collect();
    let mut readiness = json!({ "status": view.status.as_str(), "steps": steps });
    if let Some(code) = &view.error_code {
        readiness["error_code"] = Value::from(&**code);
    }
    if let Some(model) = &view.memory_model {
        readiness["memory_model"] = json!({
            "state": &*model.state,
            "bytes_done": model.bytes_done,
            "bytes_total": model.bytes_total,
            "reason": model.reason.as_deref(),
        });
    }
    readiness
}

/// Puts the report on the clipboard and says whether it worked.
pub(super) fn copy(view: &ReadinessView, lang: Lang, cx: &mut App) {
    let copy = words(lang);
    let report = match crate::lifecycle::setup::diagnostics(cx) {
        Value::Object(mut diagnostics) => {
            localize(&mut diagnostics, copy);
            diagnostics.insert("readiness".into(), readiness_json(view));
            serde_json::to_string_pretty(&Value::Object(diagnostics)).ok()
        }
        _ => None,
    };
    let toast = match report {
        Some(text) => {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            Toast::success(copy.report_copied)
        }
        None => Toast::error(copy.report_unavailable),
    };
    toast::show(cx, toast);
}
