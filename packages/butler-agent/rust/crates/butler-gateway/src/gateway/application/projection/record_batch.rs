//! One transcript pass records every complete record of its byte window in one
//! App transaction, so a burst waits for one commit instead of one per record.
//!
//! Each record keeps its own projection and its own cursor, applied in file
//! order inside a per-record savepoint; the cursor of the last recorded record
//! commits with them. A crash before the commit leaves the previous cursor, and
//! the next pass reads the same records again. A record that needs work outside
//! the transaction (the streaming buffer, artifact materialization, a terminal
//! disposition) ends the pass: it takes the asynchronous path after the commit.
use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use serde_json::Value;

use super::{
    ProjectionContext, Settlement, TranscriptEvent, byte_window::Record, checkpoint, delivery,
    final_candidate, non_final, staging, stream_window,
};
use crate::gateway::application::{
    AppApplicationDependencies, EventSubscribers, GatewayApplicationError, app_error, event_outbox,
    storage::{AppStorageError, metrics},
};

/// The end of a pass: whether it advanced, and the transcript offset it reached.
pub(super) struct Pass {
    pub advanced: bool,
    pub projected_bytes: u64,
}

struct Input {
    chat: String,
    butler_data: PathBuf,
    dependencies: Arc<AppApplicationDependencies>,
    subscribers: EventSubscribers,
}

#[derive(Default)]
struct Batch {
    projected_bytes: u64,
    settlements: Vec<Settlement>,
    stop: Option<Stop>,
}

enum Stop {
    /// Nothing of this record was written; it takes the asynchronous path.
    Deferred(Box<(TranscriptEvent, checkpoint::Checkpoint)>),
    /// This record failed after earlier records were recorded; they commit and
    /// the failure is reported, as when each record was its own pass.
    Failed(AppStorageError),
}

enum Step {
    Recorded(Option<Settlement>),
    Deferred,
}

/// Projects `records` (never empty), in file order.
pub(super) async fn project(
    context: &ProjectionContext,
    chat: &str,
    records: Vec<Record>,
) -> Result<Pass, GatewayApplicationError> {
    let first = &records[0];
    if let Some(event) = &first.event
        && context
            .streaming
            .handle(context, chat, event, &first.cursor)
            .await?
    {
        return Ok(Pass {
            advanced: true,
            projected_bytes: first.cursor.projected_bytes,
        });
    }
    context.streaming.flush(context, chat).await?;
    let input = Input {
        chat: chat.to_owned(),
        butler_data: context.butler_data.clone(),
        dependencies: context.dependencies.clone(),
        subscribers: context.subscribers.clone(),
    };
    let batch = context
        .storage
        .execute(move |db| record_all(db, &input, records))
        .await
        .map_err(app_error)?;
    butler_platform::secure_fs::abort_point("app_projection_batch_committed");
    for settlement in batch.settlements {
        context.settle_delivered(settlement).await?;
    }
    match batch.stop {
        None => Ok(Pass {
            advanced: true,
            projected_bytes: batch.projected_bytes,
        }),
        Some(Stop::Failed(error)) => Err(app_error(error)),
        Some(Stop::Deferred(deferred)) => {
            let (event, cursor) = *deferred;
            let projected_bytes = cursor.projected_bytes;
            let advanced = super::project_event(context, chat, event, cursor).await?;
            Ok(Pass {
                advanced,
                projected_bytes,
            })
        }
    }
}

fn record_all(
    db: &mut Connection,
    input: &Input,
    records: Vec<Record>,
) -> Result<Batch, AppStorageError> {
    let mut batch = Batch::default();
    for (index, record) in records.into_iter().enumerate() {
        let published = event_outbox::snapshot();
        db.execute_batch("SAVEPOINT app_projection_record")
            .map_err(AppStorageError::sqlite)?;
        let step = record_one(db, input, &record);
        let end = if matches!(step, Ok(Step::Recorded(_))) {
            "RELEASE app_projection_record"
        } else {
            "ROLLBACK TO app_projection_record; RELEASE app_projection_record"
        };
        db.execute_batch(end).map_err(AppStorageError::sqlite)?;
        match step {
            Ok(Step::Recorded(settlement)) => {
                batch.projected_bytes = record.cursor.projected_bytes;
                // Queue and turn settlement run between records, as before.
                if let Some(settlement) = settlement {
                    batch.settlements.push(settlement);
                    break;
                }
            }
            Ok(Step::Deferred) => {
                event_outbox::restore(published);
                // Only a record with an event defers; a blank line advances.
                if let Record {
                    event: Some(event),
                    cursor,
                } = record
                {
                    batch.stop = Some(Stop::Deferred(Box::new((event, cursor))));
                }
                break;
            }
            Err(error) => {
                event_outbox::restore(published);
                if index == 0 {
                    return Err(error);
                }
                batch.stop = Some(Stop::Failed(error));
                break;
            }
        }
    }
    butler_platform::secure_fs::abort_point("app_projection_batch_uncommitted");
    Ok(batch)
}

/// The synchronous part of `project_event` for one record.
fn record_one(
    db: &mut Connection,
    input: &Input,
    record: &Record,
) -> Result<Step, AppStorageError> {
    let cursor = &record.cursor;
    let clock = &input.dependencies.identity_clock;
    let action = record
        .event
        .as_ref()
        .filter(|event| event.transport.as_deref() == Some("app"))
        .and_then(|event| delivery::action_id(event).map(|action| (event, action)));
    let Some((event, action)) = action else {
        return advance(db, input, cursor);
    };
    let buffered = !metrics::baseline();
    if event.kind == "outbound" {
        if buffered && stream_window::stream_delta(event) {
            return Ok(Step::Deferred);
        }
        delivery::stage(db, &input.chat, event, &action, cursor, &clock.now_iso())?;
        return Ok(Step::Recorded(None));
    }
    if event.kind != "delivery" {
        return advance(db, input, cursor);
    }
    let Some((stored_chat, outbound)) = staging::load_awaiting(db, &action)? else {
        return advance(db, input, cursor);
    };
    if event.payload.get("ok") != Some(&Value::Bool(true)) {
        delivery::discard_staged(db, &action, cursor, &clock.now_iso())?;
        return Ok(Step::Recorded(None));
    }
    if buffered && stored_chat == input.chat && stream_window::stream_delta(&outbound) {
        return Ok(Step::Deferred);
    }
    let materialize =
        final_candidate::worker_materialization(db, &input.butler_data, &stored_chat, &outbound)?;
    if materialize.is_some() {
        return Ok(Step::Deferred);
    }
    let now = clock.now_iso();
    let ids = non_final::ProjectionIds {
        event_id: format!("turn-event-{}", clock.new_uuid()),
        message_id: format!("message-{}", clock.new_uuid()),
    };
    let outcome = non_final::apply(
        db,
        non_final::ApplyInput {
            chat_id: &stored_chat,
            action_id: &action,
            outbound: &outbound,
            cursor,
            now: &now,
            subscribers: &input.subscribers,
            ids,
            worker_files: Vec::new(),
        },
    )?;
    if !outcome.handled {
        return Ok(Step::Deferred);
    }
    let settles = outcome.wake_queue || outcome.terminal_turn.is_some();
    Ok(Step::Recorded(settles.then(|| Settlement {
        work_outcome: stream_window::projected_work_outcome(&stored_chat, &outbound),
        chat: stored_chat,
        wake_queue: outcome.wake_queue,
        terminal_turn: outcome.terminal_turn,
    })))
}

fn advance(
    db: &Connection,
    input: &Input,
    cursor: &checkpoint::Checkpoint,
) -> Result<Step, AppStorageError> {
    checkpoint::save(db, cursor, &input.dependencies.identity_clock.now_iso())?;
    Ok(Step::Recorded(None))
}
