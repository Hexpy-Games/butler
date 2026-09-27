use std::sync::Mutex;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{Frame, Relayed, StreamRelay, frames};
use crate::btcc::{AgentLoopProgress, PortFuture, RuntimeTurnEventInput};

fn delta(stream: &str, sequence: u64, text: &str) -> Relayed {
    Relayed::Delta {
        stream_id: stream.into(),
        sequence,
        text: text.into(),
    }
}

fn text(stream: &str, sequence: u64, text: &str) -> Frame {
    Frame::Text {
        stream_id: stream.into(),
        sequence,
        text: text.into(),
    }
}

fn discarded(stream: &str) -> Frame {
    Frame::Discarded {
        stream_id: stream.into(),
    }
}

/// Open stream before, batch, frames, open stream after.
type Case = (
    Option<&'static str>,
    Vec<Relayed>,
    Vec<Frame>,
    Option<&'static str>,
);

#[test]
fn frames_merge_a_streams_deltas_and_close_discarded_streams() {
    let cases: Vec<Case> = vec![
        (
            None,
            vec![delta("a", 1, "one"), delta("a", 2, " two")],
            vec![text("a", 2, "one two")],
            Some("a"),
        ),
        (
            None,
            vec![
                delta("a", 1, "x"),
                delta("b", 1, "y"),
                delta("b", 2, "\n\n"),
            ],
            vec![text("a", 1, "x"), text("b", 2, "y\n\n")],
            Some("b"),
        ),
        (
            None,
            vec![
                delta("a", 1, "Let me look."),
                Relayed::Discard,
                delta("b", 1, "Done"),
            ],
            vec![
                text("a", 1, "Let me look."),
                discarded("a"),
                text("b", 1, "Done"),
            ],
            Some("b"),
        ),
        (
            Some("a"),
            vec![Relayed::Discard],
            vec![discarded("a")],
            None,
        ),
        (None, vec![Relayed::Discard, Relayed::Discard], vec![], None),
        (Some("a"), vec![], vec![], Some("a")),
    ];
    for (before, batch, expected, after) in cases {
        let mut open = before.map(str::to_owned);
        assert_eq!(frames(&mut open, batch.clone()), expected, "{batch:?}");
        assert_eq!(open.as_deref(), after, "{batch:?}");
    }
}

#[derive(Default)]
struct Recorded(Mutex<Vec<RuntimeTurnEventInput>>);

impl AgentLoopProgress for Recorded {
    fn emit(&self, event: RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        self.0.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn publish_flushes_what_was_queued_when_the_loop_ends() {
    let relay = StreamRelay::new();
    let observer = relay.observer();
    for (stream, sequence, delta) in [("a", 1, "Let me"), ("a", 2, " look."), ("b", 1, "one")] {
        observer.event(
            &json!({"type":"text_delta","streamId":stream,"sequence":sequence,
            "textDelta":delta,"target":"final_candidate"}),
        );
    }
    observer.event(&json!({"type":"reasoning_delta","streamId":"a","textDelta":"hidden"}));
    observer.round_text_discarded();
    observer.event(&json!({"type":"text_delta","streamId":"c","sequence":1,
        "textDelta":" two","target":"final_candidate"}));
    let done = CancellationToken::new();
    done.cancel();
    let progress = Recorded::default();
    relay.publish(&progress, done).await;
    let events: Vec<(String, Value)> = progress
        .0
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|event| (event.kind, Value::Object(event.payload.unwrap_or_default())))
        .collect();
    let texts: String = events
        .iter()
        .filter(|(kind, _)| kind == "model.stream.text_delta")
        .map(|(_, payload)| payload["textDelta"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(texts, "Let me look.one two", "{events:?}");
    let discarded: Vec<&Value> = events
        .iter()
        .filter(|(kind, _)| kind == "model.stream.completed")
        .map(|(_, payload)| payload)
        .collect();
    assert_eq!(discarded, [&json!({"streamId":"b","status":"discarded"})]);
    let last = events.last().map(|(_, payload)| payload);
    assert_eq!(
        last,
        Some(&json!({"streamId":"c","sequence":1,"textDelta":" two","target":"final_candidate"}))
    );
}
