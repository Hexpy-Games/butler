//! BrowserStepStill: the images of a browser step in the timeline, read from the step's output
//! and followed by the `browser-stills` long-poll while any is still being saved.
use std::rc::Rc;
use std::time::{Duration, Instant};

use butler_ds::ui::clickable::{Clickable, Variant as ClickVariant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Basis, Cross, MinWidth, Stack, WithItem};
use butler_ds::ui::media_frame::{Aspect, MediaFrame};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, AsyncApp, ElementId, Entity, ImageSource, IntoElement as _,
    ParentElement as _, SharedString, WeakEntity, Window,
};
use serde_json::Value;

use crate::ui::i18n::browser_handoff::BrowserHandoff;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::shell::image_viewer::{self, ViewerEntry};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    BrowserStill, BrowserStillDelivery, BrowserStillOutput, BrowserStillPending,
};

/// The images the card shows, and which read produced them.
#[derive(Default)]
struct Stills {
    started: bool,
    generation: u64,
    content: Option<String>,
    images: Vec<BrowserStill>,
}

/// What one read needs: the operation output route and the tool result's own content.
struct Request {
    turn_id: String,
    call_id: String,
    result_id: String,
    content: Option<String>,
}

/// `findDelivery`: the `still_pending` marker anywhere in the value (JSON strings are opened).
fn find_delivery(value: &Value, depth: u32) -> Option<BrowserStillPending> {
    if depth > 8 {
        return None;
    }
    match value {
        Value::String(text) => find_delivery(&serde_json::from_str(text).ok()?, depth + 1),
        Value::Object(record) => record
            .get("still_pending")
            .and_then(|pending| serde_json::from_value(pending.clone()).ok())
            .or_else(|| record.values().find_map(|item| find_delivery(item, depth + 1))),
        Value::Array(items) => items.iter().find_map(|item| find_delivery(item, depth + 1)),
        _ => None,
    }
}

/// `allStills`: every still in the value, once per file.
fn all_stills(value: &Value) -> Vec<BrowserStill> {
    let children: Vec<BrowserStill> = match value {
        Value::String(text) => {
            return serde_json::from_str(text).map_or_else(|_| Vec::new(), |inner| all_stills(&inner));
        }
        Value::Object(record) => record.values().flat_map(all_stills).collect(),
        Value::Array(items) => items.iter().flat_map(all_stills).collect(),
        _ => return Vec::new(),
    };
    let own = value
        .get("still_file")
        .filter(|file| !file.is_null())
        .and_then(|_| serde_json::from_value::<BrowserStill>(value.clone()).ok());
    let mut unique: Vec<BrowserStill> = Vec::new();
    for image in own.into_iter().chain(children) {
        let url = image.still_file.as_ref().map(|file| file.url.clone());
        let same = |other: &BrowserStill| other.still_file.as_ref().map(|file| &file.url) == url.as_ref();
        match unique.iter().position(same) {
            Some(at) => unique[at] = image,
            None => unique.push(image),
        }
    }
    unique
}

/// The message file of a still whose url is a gateway message file (`valid`).
fn file_id(item: &BrowserStill) -> Option<&str> {
    let id = item.still_file.as_ref()?.url.strip_prefix("/message-files/")?;
    let uuid = id.strip_prefix("file-")?;
    (uuid.len() == 36 && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then_some(id)
}

/// Shows `images` if this read is still the current one; false once it is not (or the card left).
fn apply(
    state: &WeakEntity<Stills>,
    generation: u64,
    images: Vec<BrowserStill>,
    cx: &mut AsyncApp,
) -> bool {
    state.update(cx, |state, cx| {
        if state.generation != generation {
            return false;
        }
        state.images = images;
        cx.notify();
        true
    })
    .unwrap_or(false)
}

/// The `read` of the effect: the output's stills, then the bounded wait on the ones saving.
async fn read(state: &WeakEntity<Stills>, generation: u64, request: &Request, cx: &mut AsyncApp) {
    let content = request
        .content
        .as_deref()
        .filter(|content| !content.is_empty())
        .map(|content| Value::String(content.to_owned()));
    let marker = content.as_ref().and_then(|content| find_delivery(content, 0));
    if let (Some(content), None) = (&content, &marker) {
        apply(state, generation, all_stills(content), cx);
        return;
    }
    let (turn, call, result) = (
        request.turn_id.clone(),
        request.call_id.clone(),
        request.result_id.clone(),
    );
    let job = cx.update(|cx| {
        Jobs::run(cx, move |client| async move {
            client.get_operation_output(&turn, &call, &result, 0).await.ok()
        })
    });
    let Some(output) = job
        .await
        .flatten()
        .and_then(|value| serde_json::from_value::<BrowserStillOutput>(value).ok())
    else {
        return;
    };
    let output_content = Value::String(output.content);
    let steps = output
        .browser_stills
        .as_ref()
        .map_or_else(|| all_stills(&output_content), |delivery| delivery.steps.clone());
    if !apply(state, generation, steps, cx) {
        return;
    }
    let pending = marker.or_else(|| find_delivery(&output_content, 0));
    let (Some(mut delivery), Some(pending)) = (output.browser_stills, pending) else {
        return;
    };
    // Bound observation of an unavailable host; a later mount reads the durable state again.
    let until = Instant::now() + Duration::from_secs(60);
    while !delivery.complete
        && delivery.steps.iter().any(|step| step.state.as_deref() == Some("pending"))
        && Instant::now() < until
    {
        let (act, session) = (delivery.act_id.clone(), pending.session.clone());
        let job = cx.update(|cx| {
            Jobs::run(cx, move |client| async move {
                client.get_browser_stills(&act, &session, true).await.ok()
            })
        });
        let Some(next) = job
            .await
            .flatten()
            .and_then(|value| serde_json::from_value::<BrowserStillDelivery>(value).ok())
        else {
            return;
        };
        delivery = next;
        if !apply(state, generation, delivery.steps.clone(), cx) {
            return;
        }
    }
}

/// `BrowserStepStill`: the step's images as a column of 16:10 frames; each opens the image
/// viewer. `None` while there is nothing to show.
pub(crate) fn browser_step_still(
    turn_id: &str,
    call_id: &str,
    result_id: &str,
    content: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let key = SharedString::from(format!("{turn_id}:{call_id}:{result_id}"));
    let state = window.use_keyed_state(
        (ElementId::from("browser-step-still"), key.clone()),
        cx,
        |_, _| Stills::default(),
    );
    let current = {
        let seen = state.read(cx);
        seen.started && seen.content.as_deref() == content
    };
    if !current {
        let generation = state.update(cx, |state, _| {
            state.started = true;
            state.generation += 1;
            state.content = content.map(str::to_owned);
            state.images.clear();
            state.generation
        });
        let request = Request {
            turn_id: turn_id.to_owned(),
            call_id: call_id.to_owned(),
            result_id: result_id.to_owned(),
            content: content.map(str::to_owned),
        };
        let weak = state.downgrade();
        cx.spawn(async move |cx| read(&weak, generation, &request, cx).await)
            .detach();
    }
    let images = state.read(cx).images.clone();
    if images.is_empty() {
        return None;
    }
    Some(still_column(&images, &key, cx))
}

/// The frames of `images`, in order.
fn still_column(images: &[BrowserStill], key: &SharedString, cx: &mut App) -> AnyElement {
    let copy = BrowserHandoff::get(cx);
    let lang = Ds::get(cx).lang();
    let shots: Rc<Vec<ViewerEntry>> = Rc::new(
        images
            .iter()
            .filter_map(file_id)
            .map(|id| ViewerEntry::new(PictureId::File(id.to_owned()), copy.still.to_owned()))
            .collect(),
    );
    let mut shot_index = 0;
    let mut column = Stack::new().basis(Basis::Md).shrink(true).min_width(MinWidth::Zero);
    for (index, item) in images.iter().enumerate() {
        let id = ElementId::from(SharedString::from(format!("{key}:{index}")));
        let file = file_id(item);
        let shot = file.map(|_| {
            shot_index += 1;
            shot_index - 1
        });
        let failed = item.state.as_deref() == Some("failed");
        let reason = item
            .reason
            .as_deref()
            .and_then(|reason| BrowserHandoff::still_failure(lang, reason))
            .unwrap_or(copy.still_unavailable);
        let mut frame = MediaFrame::new((id.clone(), "frame"))
            .aspect(Aspect::SixteenTen)
            .placeholder();
        if let Some(image) = file.and_then(|id| picture(&PictureId::File(id.to_owned()), cx)) {
            frame = frame.src(ImageSource::Image(image));
        }
        if file.is_none() {
            frame = frame.child(Typo::caption(if failed { reason } else { copy.still_pending }));
        }
        let mut open = Clickable::new((id.clone(), "open"))
            .variant(ClickVariant::Text)
            .stretch();
        match shot {
            Some(selected) => {
                let shots = shots.clone();
                open = open.on_click(move |_, _, cx| {
                    image_viewer::open(shots.as_ref().clone(), selected, cx);
                });
            }
            None => open = open.disabled(),
        }
        let open = open.child(Stack::new().grow().min_width(MinWidth::Zero).child(frame));
        let mut tip = Tooltip::new((id, "tip"));
        if failed {
            tip = tip.label(reason);
        }
        column = column.child(tip.child(open));
    }
    Stack::row().cross(Cross::Start).child(column).into_any_element()
}
