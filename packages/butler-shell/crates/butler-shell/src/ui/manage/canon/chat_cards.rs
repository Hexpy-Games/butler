//! Electron `ChatEpicCards.tsx` and `useChatCanon.ts`: mounted surfaces share an event-driven read.
use std::{collections::HashMap, rc::Rc};

use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Columns, Grid, GridCross, Space, Stack};
use butler_ds::ui::skeleton::{Height, Skeleton};
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Global, IntoElement as _,
    ParentElement as _, Render, SharedString, WeakEntity, Window, div,
};

use super::board::card::{Opts, card};
use crate::ui::manage::dashboard::open_canon_epic;
use crate::ui::manage::{Topic, window_ctx};
use crate::ui::source::fetch::{Flight, fetch};
use crate::ui::source::wire::{CanonOverview, EpicCard};
use crate::ui::widgets::anchor;

#[derive(Default)]
struct Readers(HashMap<String, WeakEntity<Reader>>);
impl Global for Readers {}

#[derive(Default)]
enum Snapshot {
    #[default]
    Loading,
    Ready(HashMap<String, EpicCard>),
    Missing,
    Error,
}

struct Reader {
    project: String,
    snapshot: Snapshot,
    flight: Flight,
    seen: u64,
}

impl Reader {
    /// Electron `useChatCanon.ts`: the last surface releases the read and its subscription.
    fn shared(project: &str, cx: &mut App) -> Entity<Self> {
        if let Some(reader) = cx
            .default_global::<Readers>()
            .0
            .get(project)
            .and_then(WeakEntity::upgrade)
        {
            return reader;
        }
        let key = project.to_owned();
        let reader = cx.new(|cx| Self::new(project, cx));
        cx.default_global::<Readers>()
            .0
            .insert(key.clone(), reader.downgrade());
        reader.update(cx, |_, cx| {
            cx.on_release(move |_, cx| {
                cx.default_global::<Readers>().0.remove(&key);
            })
            .detach();
        });
        reader
    }

    fn new(project: &str, cx: &mut Context<Self>) -> Self {
        let topic = Topic::Canon(project.to_owned().into());
        let mut seen = 0;
        if let Some(ctx) = window_ctx(cx) {
            seen = ctx.live.read(cx).revision(&topic);
            cx.observe(&ctx.live, move |this, live, cx| {
                let revision = live.read(cx).revision(&topic);
                if revision != this.seen {
                    this.seen = revision;
                    this.refresh(cx);
                }
            })
            .detach();
        }
        let mut this = Self {
            project: project.to_owned(),
            snapshot: Snapshot::Loading,
            flight: Flight::default(),
            seen,
        };
        this.refresh(cx);
        this
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.flight.begin() {
            self.read(cx);
        }
    }

    fn read(&mut self, cx: &mut Context<Self>) {
        let project = self.project.clone();
        fetch(
            cx,
            move |client| async move { client.get_canon(&project).await },
            |this: &mut Self, result: Result<CanonOverview, Error>, cx| {
                this.snapshot = match result {
                    Ok(canon) => Snapshot::Ready(
                        canon
                            .backlog
                            .into_iter()
                            .chain(canon.plans.into_iter().flat_map(|plan| plan.works))
                            .map(|epic| (epic.id.clone(), epic))
                            .collect(),
                    ),
                    Err(Error::Http(404)) => Snapshot::Missing,
                    Err(_) => Snapshot::Error,
                };
                if this.flight.end() {
                    this.read(cx);
                }
            },
        );
    }
}

pub(crate) type Wrap = Rc<dyn Fn(AnyElement, &App) -> AnyElement>;

struct ChatEpicCards {
    wrap: Option<Wrap>,
    reader: Entity<Reader>,
    project: String,
    ids: Vec<String>,
}

/// Electron `ChatEpicCards.tsx`: stable state per mounted grid; id order is preserved.
pub(crate) fn chat_epic_cards(
    key: &str,
    project: &str,
    ids: &[String],
    wrap: Option<Wrap>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let view = window.use_keyed_state(
        SharedString::from(format!("chat-epics-{project}-{key}")),
        cx,
        |_, cx| {
            let reader = Reader::shared(project, cx);
            cx.observe(&reader, |_, _, cx| cx.notify()).detach();
            ChatEpicCards {
                wrap: None,
                reader,
                project: project.to_owned(),
                ids: ids.to_vec(),
            }
        },
    );
    view.update(cx, |this, _| {
        this.ids = ids.to_vec();
        this.wrap = wrap;
    });
    view.into_any_element()
}

impl Render for ChatEpicCards {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let snapshot = &self.reader.read(cx).snapshot;
        if matches!(snapshot, Snapshot::Error) {
            return div().into_any_element();
        }
        let cards = self.ids.iter().map(|id| self.epic(id, snapshot, cx));
        let grid = anchor(div(), "chat-epic-cards")
            .child(
                Grid::new("chat-epic-grid")
                    .columns(Columns::AUTO_FILL)
                    .cross(GridCross::Start)
                    .gap(Space::Sm)
                    .children(cards),
            )
            .into_any_element();
        match &self.wrap {
            Some(wrap) => wrap(grid, cx),
            None => grid,
        }
    }
}

impl ChatEpicCards {
    fn epic(&self, id: &str, snapshot: &Snapshot, cx: &App) -> AnyElement {
        if let Snapshot::Ready(epics) = snapshot
            && let Some(epic) = epics.get(id)
        {
            let project = self.project.clone();
            return card(
                epic,
                Opts {
                    ordinal: None,
                    selected: false,
                    show_status: true,
                    on_select: Some(Rc::new(move |id, _, cx| {
                        open_canon_epic(&project, Some(&id), cx);
                    })),
                },
                cx,
            )
            .into_any_element();
        }
        let body = if matches!(snapshot, Snapshot::Loading) {
            Stack::new()
                .gap(Space::Sm)
                .child(
                    Skeleton::new(SharedString::from(format!("{id}-title"))).height(Height::Title),
                )
                .child(Skeleton::new(SharedString::from(format!("{id}-lines"))).lines(2))
                .into_any_element()
        } else {
            let deleted = match Ds::get(cx).lang() {
                Lang::Ko => "삭제된 과제",
                Lang::En => "Deleted Epic",
            };
            Typo::caption(deleted)
                .tone(Tone::Secondary)
                .into_any_element()
        };
        Card::new(SharedString::from(format!("chat-epic-{id}")))
            .padding(CardPadding::Md)
            .child(body)
            .into_any_element()
    }
}
