//! `useImageOutputs`: the pictures a turn's image tool calls made. Each call's output is read
//! once, on the agent worker, and kept; one that could not be read is asked again when the
//! turn's revision moves.
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{App, Global, SharedString};

use super::{ImageAsset, ImageToolRow, api};
use crate::ui::source::agent::Jobs;

/// Turn, call and result of one output.
type Key = (String, String, String);

enum Entry {
    Reading,
    Done {
        images: Vec<Rc<ImageAsset>>,
        failed: bool,
    },
    /// The read failed at this revision.
    Unavailable(SharedString),
}

#[derive(Default)]
struct Outputs(HashMap<Key, Entry>);

impl Global for Outputs {}

/// What `useImageOutputs` returns.
pub(super) struct Read {
    pub(super) images: Vec<Rc<ImageAsset>>,
    pub(super) loading: bool,
    pub(super) failed: bool,
    pub(super) unavailable: bool,
}

/// The turn's pictures in tool order. Starts the reads it has not started; the windows refresh
/// when one ends.
pub(super) fn read(
    turn: Option<&str>,
    rows: &[ImageToolRow],
    revision: &str,
    cx: &mut App,
) -> Read {
    let mut out = Read {
        images: Vec::new(),
        loading: false,
        failed: rows.iter().any(|row| row.failed),
        unavailable: false,
    };
    let Some(turn) = turn else {
        return out;
    };
    for row in rows {
        let key = (
            turn.to_owned(),
            row.call_id.to_string(),
            row.result_id.to_string(),
        );
        match cx.default_global::<Outputs>().0.get(&key) {
            Some(Entry::Done { images, failed }) => {
                out.images.extend(images.iter().cloned());
                out.failed |= *failed;
            }
            Some(Entry::Reading) => out.loading = true,
            Some(Entry::Unavailable(seen)) if seen.as_ref() == revision => out.unavailable = true,
            _ => {
                out.loading = true;
                start(key, revision, cx);
            }
        }
    }
    if out.unavailable {
        out.images.clear();
    }
    out
}

fn start(key: Key, revision: &str, cx: &mut App) {
    if Jobs::client(cx).is_none() {
        return;
    }
    cx.default_global::<Outputs>()
        .0
        .insert(key.clone(), Entry::Reading);
    let (turn, call, result) = key.clone();
    let revision = SharedString::from(revision.to_owned());
    let job = Jobs::run(cx, move |client| async move {
        api::read_call(&client, &turn, &call, &result).await
    });
    cx.spawn(async move |cx| {
        let entry = match job.await.flatten() {
            Some((images, failed)) => Entry::Done {
                images: images.into_iter().map(Rc::new).collect(),
                failed,
            },
            None => Entry::Unavailable(revision),
        };
        cx.update(|cx| {
            cx.default_global::<Outputs>().0.insert(key, entry);
            cx.refresh_windows();
        });
    })
    .detach();
}
