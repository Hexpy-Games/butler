use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, VecDeque},
    convert::Infallible,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, Waker},
    time::Duration,
};

use axum::body::Bytes;
use futures_core::Stream;
use tokio::time::{Instant, Interval};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use super::{
    AppEventEnvelope, EventSubscription, GatewayApplication, GatewayApplicationError,
    protocol::APP_PROTOCOL_VERSION,
};

const MAX_REPLAY_EVENTS: usize = 200;
const MAX_BUFFERED_EVENTS: usize = 128;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT: &str = "event: heartbeat\ndata: null\n\n";

pub(super) async fn create_live_stream(
    application: Arc<dyn GatewayApplication>,
    cursor: f64,
    shutdown: CancellationToken,
) -> Result<LiveEventStream, GatewayApplicationError> {
    let state = Arc::new(Mutex::new(LiveState::new(cursor)));
    let callback_state = state.clone();
    let callback_application = Arc::downgrade(&application);
    let subscription = application.subscribe_events(Arc::new(move |event| {
        if callback_application.upgrade().is_none() {
            return;
        }
        let high_water = event.id;
        let waker = state_lock(&callback_state).receive(event, high_water);
        if let Some(waker) = waker {
            waker.wake();
        }
    }))?;

    let high_water = application.latest_event_cursor().await?;
    let replay = if high_water as f64 - cursor > MAX_REPLAY_EVENTS as f64 {
        None
    } else {
        Some(application.replay_events(cursor, MAX_REPLAY_EVENTS).await?)
    };
    let current_high_water = application.latest_event_cursor().await?;
    {
        let mut state = state_lock(&state);
        if let Some(replay) = replay {
            if replay
                .first()
                .is_some_and(|event| event.id as f64 > state.cursor + 1.0)
            {
                state.push_reconcile(high_water);
            } else {
                for event in replay
                    .into_iter()
                    .take_while(|event| event.id <= high_water)
                {
                    state.push_output(event, high_water);
                }
            }
        } else {
            state.push_reconcile(high_water);
        }
        state.finish_replay(current_high_water);
        state.push_chunk(Bytes::from_static(HEARTBEAT.as_bytes()), current_high_water);
    }

    Ok(LiveEventStream {
        state,
        _subscription: subscription,
        heartbeat: heartbeat_interval(),
        shutdown: Box::pin(shutdown.cancelled_owned()),
    })
}

fn state_lock(state: &Arc<Mutex<LiveState>>) -> parking_lot::MutexGuard<'_, LiveState> {
    state.lock()
}

struct LiveState {
    cursor: f64,
    replaying: bool,
    replay_overflowed: bool,
    replay_queue: BTreeMap<u64, AppEventEnvelope>,
    output: VecDeque<Bytes>,
    waker: Option<Waker>,
}

impl LiveState {
    fn new(cursor: f64) -> Self {
        Self {
            cursor,
            replaying: true,
            replay_overflowed: false,
            replay_queue: BTreeMap::new(),
            output: VecDeque::new(),
            waker: None,
        }
    }

    fn receive(&mut self, event: AppEventEnvelope, high_water: u64) -> Option<Waker> {
        if event.id as f64 <= self.cursor {
            return None;
        }
        if self.replaying {
            if self.replay_queue.len() >= MAX_REPLAY_EVENTS {
                self.replay_queue.clear();
                self.replay_overflowed = true;
            } else if !self.replay_overflowed {
                self.replay_queue.insert(event.id, event);
            }
            return None;
        }
        self.push_output(event, high_water);
        self.waker.take()
    }

    fn finish_replay(&mut self, current_high_water: u64) {
        if self.replay_overflowed {
            self.push_reconcile(current_high_water);
        } else {
            let queued = std::mem::take(&mut self.replay_queue);
            for event in queued.into_values() {
                self.push_output(event, current_high_water);
            }
        }
        self.replaying = false;
        self.replay_queue.clear();
        self.replay_overflowed = false;
    }

    fn push_output(&mut self, event: AppEventEnvelope, high_water: u64) {
        if event.id as f64 <= self.cursor {
            return;
        }
        self.push_chunk(format_event(&event), high_water);
        self.cursor = event.id as f64;
    }

    fn push_reconcile(&mut self, high_water: u64) {
        let event = AppEventEnvelope {
            protocol_version: APP_PROTOCOL_VERSION.to_owned(),
            id: high_water,
            event_type: "stream.reconcile_required".to_owned(),
            created_at: iso_timestamp_now(),
            payload: serde_json::Map::from_iter([
                ("after_cursor".to_owned(), self.cursor.into()),
                ("high_water_cursor".to_owned(), high_water.into()),
            ]),
        };
        self.push_chunk(format_event(&event), high_water);
        self.cursor = high_water as f64;
    }

    fn push_chunk(&mut self, chunk: Bytes, high_water: u64) {
        if self.output.len() >= MAX_BUFFERED_EVENTS {
            self.output.clear();
            let event = AppEventEnvelope {
                protocol_version: APP_PROTOCOL_VERSION.to_owned(),
                id: high_water,
                event_type: "stream.reconcile_required".to_owned(),
                created_at: iso_timestamp_now(),
                payload: serde_json::Map::from_iter([
                    ("after_cursor".to_owned(), self.cursor.into()),
                    ("high_water_cursor".to_owned(), high_water.into()),
                ]),
            };
            self.output.push_back(format_event(&event));
        } else {
            self.output.push_back(chunk);
        }
    }
}

pub(super) struct LiveEventStream {
    state: Arc<Mutex<LiveState>>,
    _subscription: Box<dyn EventSubscription>,
    heartbeat: Interval,
    shutdown: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl Stream for LiveEventStream {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.shutdown.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        let chunk = {
            let mut state = self.state.lock();
            let chunk = state.output.pop_front();
            if chunk.is_none() {
                state.waker = Some(cx.waker().clone());
            }
            chunk
        };
        if let Some(chunk) = chunk {
            return Poll::Ready(Some(Ok(chunk)));
        }
        if self.heartbeat.poll_tick(cx).is_ready() {
            return Poll::Ready(Some(Ok(Bytes::from_static(HEARTBEAT.as_bytes()))));
        }
        Poll::Pending
    }
}

fn format_event(event: &AppEventEnvelope) -> Bytes {
    // An envelope of strings, an integer and a JSON map always serializes.
    let data = serde_json::to_string(event).unwrap_or_default();
    Bytes::from(format!("id: {}\ndata: {data}\n\n", event.id))
}

fn heartbeat_interval() -> Interval {
    let mut interval =
        tokio::time::interval_at(Instant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
}

fn iso_timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs();
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60,
        duration.subsec_millis()
    )
}

fn civil_date(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
