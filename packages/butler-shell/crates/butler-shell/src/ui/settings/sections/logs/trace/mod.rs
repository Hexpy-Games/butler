//! Logs: the trace page, its title and the log storage section (`LogTracePage.tsx`,
//! `LogTraceTitle.tsx`, `TraceSummary.tsx`, `TraceStepRow.tsx`, `TraceStepDetail.tsx`,
//! `traceApi.ts`, `traceModel.ts`, `traceText.ts`, `LogStorage.tsx`, `LogExportDialog.tsx`).
//! U10 calls these signatures.
mod copy;
mod export;
mod model;
mod page;
mod step;
mod storage;
mod text;
mod title;

use gpui::SharedString;

pub(crate) use page::TracePage;
pub(crate) use storage::{LogStorage, LogStorageEvent};
pub(crate) use title::trace_title;

/// `LogTraceTarget`: a trace. The turn and chat-message targets come with the palette and chat
/// trace links (F2).
#[derive(Clone)]
pub(crate) enum TraceTarget {
    Trace(SharedString),
}
