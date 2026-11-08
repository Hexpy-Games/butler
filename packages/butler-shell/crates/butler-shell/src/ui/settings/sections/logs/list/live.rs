//! `useLiveLogs`: GET /logs/live while the Live switch is on. The client reconnects on its own;
//! a stream that ends or fails is lost. Dropping [`Live`] closes it.
use butler_shell_client::Error;
use futures::StreamExt as _;
use futures::channel::{mpsc, oneshot};
use futures::future::{Either, select};
use gpui::{Context, Task};
use serde_json::Value;

use super::LogList;
use super::api::LogRecord;
use crate::ui::source::agent::Jobs;

pub(super) struct Live {
    _stop: oneshot::Sender<()>,
    _task: Task<()>,
}

/// Opens the stream on the agent worker and feeds the list from it.
pub(super) fn connect(cx: &mut Context<LogList>) -> Live {
    let (stop, mut stopped) = oneshot::channel::<()>();
    let (records, mut incoming) = mpsc::unbounded::<Result<Value, Error>>();
    // The job runs to its end on the worker; its result is not awaited.
    drop(Jobs::run(cx, move |client| async move {
        let mut stream = client.live_logs();
        loop {
            match select(stream.next(), &mut stopped).await {
                Either::Left((Some(item), _)) => {
                    if records.unbounded_send(item).is_err() {
                        return;
                    }
                }
                Either::Left((None, _)) | Either::Right(_) => return,
            }
        }
    }));
    let task = cx.spawn(async move |this, cx| {
        while let Some(Ok(raw)) = incoming.next().await {
            if let Ok(record) = serde_json::from_value::<LogRecord>(raw) {
                let _ = this.update(cx, |list, cx| list.on_live(record, cx));
            }
        }
        let _ = this.update(cx, super::LogList::live_lost);
    });
    Live {
        _stop: stop,
        _task: task,
    }
}
