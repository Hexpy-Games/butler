//! `useSessionViewSubscription.ts`: shared, revision-driven child session views.
use std::collections::HashMap;
use std::rc::Rc;

use butler_shell_client::Error;
use gpui::{App, AppContext as _, Context, Entity, Global, SharedString, Subscription};

use crate::ui::manage::{ManageLive, Topic};
use crate::ui::source::fetch::{Flight, fetch_if};
use crate::ui::source::wire::{MessageRecordRole, ProgressRow, SessionView};
use crate::ui::store::progress::activity::{PhaseActivity, project_turn_activity};
use butler_ds::ui::context::Lang;

struct Entry {
    revision: u64,
    view: Option<Rc<SessionView>>,
    flight: Flight,
}

/// Entries are retained between renders; only topic changes trigger another read.
struct ChildViews {
    live: Entity<ManageLive>,
    entries: HashMap<SharedString, Entry>,
    _live: Subscription,
}

struct Cache(Entity<ChildViews>);
impl Global for Cache {}

/// Installed with the shell's transcript hooks, following the observer's live bus.
pub(crate) fn install(live: Entity<ManageLive>, cx: &mut App) {
    let cache = cx.new(|cx| {
        let follow = cx.observe(&live, |this: &mut ChildViews, live, cx| {
            let changed: Vec<_> = this
                .entries
                .iter_mut()
                .filter_map(|(id, entry)| {
                    let revision = live.read(cx).revision(&Topic::Session(id.clone()));
                    if revision == entry.revision {
                        return None;
                    }
                    entry.revision = revision;
                    Some(id.clone())
                })
                .collect();
            for session in changed {
                this.refresh(session, cx);
            }
        });
        ChildViews {
            live,
            entries: HashMap::new(),
            _live: follow,
        }
    });
    cx.set_global(Cache(cache));
}

/// Ask once while rendering; a pending or failed read never causes per-render requests.
pub(crate) fn view(session: &str, cx: &mut App) -> Option<Rc<SessionView>> {
    let cache = cx.try_global::<Cache>()?.0.clone();
    let session = SharedString::from(session.to_owned());
    cache.update(cx, |cache, cx| {
        if !cache.entries.contains_key(&session) {
            let revision = cache
                .live
                .read(cx)
                .revision(&Topic::Session(session.clone()));
            cache.entries.insert(
                session.clone(),
                Entry {
                    revision,
                    view: None,
                    flight: Flight::default(),
                },
            );
            cache.refresh(session.clone(), cx);
        }
        cache
            .entries
            .get(&session)
            .and_then(|entry| entry.view.clone())
    })
}

impl ChildViews {
    /// `SessionObserver.refresh`: coalesce revisions arriving during a read.
    fn refresh(&mut self, session: SharedString, cx: &mut Context<Self>) {
        if self
            .entries
            .get_mut(&session)
            .is_some_and(|entry| entry.flight.begin())
        {
            Self::read(session, cx);
        }
    }

    /// `SessionObserver.read`: the same bounded message window on the agent worker.
    fn read(session: SharedString, cx: &mut Context<Self>) {
        let asked = session.clone();
        fetch_if(
            cx,
            move |client| async move { client.message_window(&session, None, 200).await },
            move |this: &mut Self, result: Result<SessionView, Error>, cx| {
                let Some(entry) = this.entries.get_mut(&asked) else {
                    return false;
                };
                let again = entry.flight.end();
                let mut changed = false;
                if let Ok(view) = result
                    && entry.view.as_deref() != Some(&view)
                {
                    entry.view = Some(Rc::new(view));
                    changed = true;
                }
                if again {
                    Self::read(asked, cx);
                }
                if changed {
                    cx.refresh_windows();
                }
                changed
            },
        );
    }
}

pub(super) struct StepActivity {
    pub(super) phase: PhaseActivity,
    pub(super) turn: String,
    pub(super) action: Option<String>,
}

struct ActivitySource<'a> {
    turn: &'a str,
    at: Option<&'a str>,
    rows: &'a [ProgressRow],
}

/// `observerActivitySources.ts`: Map replacement keeps a turn's original insertion order.
fn set_source<'a>(
    source: ActivitySource<'a>,
    sources: &mut Vec<ActivitySource<'a>>,
    indices: &mut HashMap<&'a str, usize>,
) {
    let index = *indices.entry(source.turn).or_insert(sources.len());
    if index == sources.len() {
        sources.push(source);
    } else {
        sources[index] = source;
    }
}

/// `observerActivitySources.ts`: messages override history; the active turn overrides all.
fn sources(view: &SessionView) -> Vec<ActivitySource<'_>> {
    let mut sources = Vec::new();
    let mut indices = HashMap::new();
    for source in view.activity_history.iter().flatten() {
        set_source(
            ActivitySource {
                turn: &source.turn_id,
                at: Some(&source.created_at),
                rows: &source.rows,
            },
            &mut sources,
            &mut indices,
        );
    }
    for message in &view.messages {
        if message.role == MessageRecordRole::Assistant
            && let Some(turn) = message.turn_id.as_deref().filter(|id| !id.is_empty())
            && let Some(rows) = message
                .turn_activity_rows
                .as_deref()
                .filter(|rows| !rows.is_empty())
        {
            let at = rows
                .iter()
                .filter_map(|row| row.created_at.as_deref())
                .find(|at| !at.is_empty())
                .or(message.created_at.as_deref());
            set_source(
                ActivitySource { turn, at, rows },
                &mut sources,
                &mut indices,
            );
        }
    }
    if let Some(turn) = view
        .latest_turn
        .as_ref()
        .filter(|turn| !indices.contains_key(turn.id.as_str()))
    {
        set_source(turn_source(turn), &mut sources, &mut indices);
    }
    if let Some(turn) = &view.active_turn {
        set_source(turn_source(turn), &mut sources, &mut indices);
    }
    sources
}

/// `observerActivitySources.ts`: child turns retain their public rows on progress.
fn turn_source(turn: &crate::ui::source::wire::SessionViewTurn) -> ActivitySource<'_> {
    ActivitySource {
        turn: &turn.id,
        at: Some(&turn.created_at),
        rows: turn
            .progress
            .as_ref()
            .map_or(&[], |p| p.safe_progress_rows.as_slice()),
    }
}

/// `SessionObserverStepTimeline.tsx` projectActivities, including model-authored action keys.
pub(super) fn project(view: &SessionView, lang: Lang) -> Vec<StepActivity> {
    let mut activities = Vec::new();
    for ActivitySource { turn, at, rows } in sources(view) {
        for mut phase in project_turn_activity(lang, rows, Some(turn)).phase_activities {
            let action = rows
                .iter()
                .rev()
                .find(|row| {
                    row.id == phase.id
                        && row.work_decision_source.as_deref() == Some("model-authored")
                })
                .and_then(|row| row.action_key.clone());
            if phase.created_at.is_none() {
                phase.created_at = at.map(str::to_owned);
            }
            activities.push(StepActivity {
                phase,
                turn: turn.to_owned(),
                action,
            });
        }
    }
    activities.sort_by(|a, b| a.phase.created_at.cmp(&b.phase.created_at));
    activities
}
