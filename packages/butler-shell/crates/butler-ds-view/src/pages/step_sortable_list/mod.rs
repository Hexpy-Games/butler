//! StepSortableList.showcase.tsx (with StepSortableList.demo.tsx and .fixtures.ts): chains of
//! steps in a work-tab list. The first five stories are live lists (drag a card or its grip,
//! or lift with Space on a grip); the last two are static drag states. Shapes are codes: a
//! letter is a task, `+` joins a 묶음, `!` running, `~` in review, `?` held, `.` done, `x` failed.
use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::blocks::step_sortable_list::{
    StepSortableChain, StepSortableDragPreview, StepSortableItem, StepSortableList,
    StepSortableOutcome, StepSortableRowContext, StepSortableRowSlots, StepSortableTarget,
    StepSortableTargetKind, apply_step_sortable_edit,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::success_check::SuccessCheck;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::Story;
use crate::copy::Lang;
use copy::{Copy, copy, ko_labels};

mod copy;

type Shape = &'static [&'static [&'static str]];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Running,
    Review,
    Pending,
    Held,
    Done,
    Failed,
}

impl Status {
    /// Index into the copy's status names.
    fn at(self) -> usize {
        self as usize
    }
}

/// A demo task's own state (the work-tab mockup's tasks).
#[derive(Clone)]
struct DemoTask {
    letter: usize,
    status: Status,
    progress: Option<&'static str>,
    time: Option<&'static str>,
    result: Option<&'static str>,
}

const STATUS_CODES: [(char, Status); 5] = [
    ('!', Status::Running),
    ('~', Status::Review),
    ('?', Status::Held),
    ('.', Status::Done),
    ('x', Status::Failed),
];

const SINGLE: Shape = &[&["a!", "b", "c", "d"]];
const MULTIPLE: Shape = &[&["a!", "b+c", "d"], &["e!", "f"]];
const WITH_STACK: Shape = &[&["a!", "b+c+d", "e"]];
const PINNED: Shape = &[&["a!", "b", "c"]];
const HELD_DONE: Shape = &[&["a.", "e!", "b?", "c?"]];
const PREVIEW: Shape = &[&["a!", "b", "d"], &["e!", "f"]];

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Single chain",
            render: |lang, window, cx| demo("single", lang, SINGLE, None, window, cx),
        },
        Story {
            name: "Multiple chains",
            render: |lang, window, cx| demo("multiple", lang, MULTIPLE, None, window, cx),
        },
        Story {
            name: "Step with a stack",
            render: |lang, window, cx| demo("stack", lang, WITH_STACK, None, window, cx),
        },
        Story {
            name: "Pinned running row",
            render: |lang, window, cx| demo("pinned", lang, PINNED, None, window, cx),
        },
        Story {
            name: "Held and done rows",
            render: |lang, window, cx| demo("held", lang, HELD_DONE, None, window, cx),
        },
        Story {
            name: "Drag over a gap",
            render: |lang, window, cx| {
                let preview = preview(&["d"], 1, StepSortableTargetKind::Gap);
                demo("gap", lang, PREVIEW, Some(preview), window, cx)
            },
        },
        Story {
            name: "Dwell on a step (join)",
            render: |lang, window, cx| {
                let preview = preview(&["f"], 2, StepSortableTargetKind::Join);
                demo("join", lang, PREVIEW, Some(preview), window, cx)
            },
        },
    ]
}

/// "Write the talk script" over the gap before step 1, "Send the summary email" resting on step 2.
fn preview(ids: &[&'static str], step_index: usize, kind: StepSortableTargetKind) -> StepSortableDragPreview {
    StepSortableDragPreview {
        item_ids: ids.iter().map(|id| SharedString::from(*id)).collect(),
        target: StepSortableTarget {
            chain_id: "chain-0".into(),
            step_index,
            kind,
        },
    }
}

/// The chains of a shape and each task's state, by item id.
fn demo_chains(c: &Copy, shape: Shape) -> (Vec<StepSortableChain>, HashMap<SharedString, DemoTask>) {
    let mut tasks = HashMap::new();
    let mut task = |code: &'static str| -> StepSortableItem {
        let marks = &code[1..];
        let status = STATUS_CODES
            .iter()
            .find(|(mark, _)| marks.contains(*mark))
            .map_or(Status::Pending, |(_, status)| *status);
        let live = matches!(status, Status::Running | Status::Review);
        let letter = usize::from(code.as_bytes()[0] - b'a');
        let id = SharedString::from(&code[..1]);
        tasks.insert(
            id.clone(),
            DemoTask {
                letter,
                status,
                progress: live.then(|| c.progress[letter]),
                time: live.then(|| c.time[letter]),
                result: (status == Status::Done).then(|| c.result[letter]),
            },
        );
        StepSortableItem::new(id, c.titles[letter])
            .running(live)
            .done(status == Status::Done)
    };
    let chains = shape
        .iter()
        .enumerate()
        .map(|(index, steps)| StepSortableChain {
            id: format!("chain-{index}").into(),
            label: c.chains[index].into(),
            title: (shape.len() > 1).then(|| c.chains[index].into()),
            steps: steps
                .iter()
                .map(|step| step.split('+').map(&mut task).collect())
                .collect(),
        })
        .collect();
    (chains, tasks)
}

/// Heads show their status glyph; follow-up steps their number in the chain.
fn marker(id: &str, status: Status, number: Option<usize>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let side = ds.len(Length::IconSizeMd);
    match (number, status) {
        (Some(number), _) => Typo::label(number.to_string()).tone(Tone::Tertiary).tabular().into_any_element(),
        (None, Status::Running) => Spinner::new(format!("ssl-spin-{id}")).size(f32::from(side)).into_any_element(),
        (None, Status::Done) => SuccessCheck::new(format!("ssl-check-{id}"))
            .ring()
            .size(f32::from(side))
            .still()
            .into_any_element(),
        (None, Status::Review) => icon_px(Icon::Eye, side).into_any_element(),
        (None, Status::Failed) => div()
            .text_color(ds.color(Color::ColorDangerText))
            .child(icon_px(Icon::AlertCircle, side))
            .into_any_element(),
        (None, _) => icon_px(Icon::Minus, side).into_any_element(),
    }
}

/// One line about the row's own state (the meta already says the status word): progress, result,
/// why it waits or pauses.
fn state_caption(c: &Copy, task: &DemoTask, before: Option<(&DemoTask, &str)>) -> String {
    if let Some(progress) = task.progress.or(task.result) {
        return progress.to_owned();
    }
    match (task.status, before) {
        (Status::Held, Some((before, _))) if before.status == Status::Held => c.paused_before.to_owned(),
        (Status::Held, _) => c.paused_by_you.to_owned(),
        (_, Some((_, title))) => (c.after)(title),
        (_, None) => c.not_started.to_owned(),
    }
}

/// The work-tab row content: what a product container maps its tasks to.
fn row_slots(
    story: &'static str,
    c: &Copy,
    (chains, tasks): (&[StepSortableChain], &HashMap<SharedString, DemoTask>),
    (item, place): (&StepSortableItem, &StepSortableRowContext),
    cx: &App,
) -> StepSortableRowSlots {
    let Some(task) = tasks.get(&item.id) else {
        return StepSortableRowSlots::default();
    };
    let head = place.step_index == 0;
    let before = if head {
        None
    } else {
        chains
            .iter()
            .find(|chain| chain.id == place.chain_id)
            .and_then(|chain| chain.steps.get(place.step_index - 1))
            .and_then(|step| step.first())
            .and_then(|first| tasks.get(&first.id).map(|task| (task, first.label.as_ref())))
    };
    let caption = match (place.lifted, place.outcome) {
        (true, Some(StepSortableOutcome::Join)) => c.join.to_owned(),
        (true, Some(StepSortableOutcome::NewStep)) => c.new_step.to_owned(),
        _ => state_caption(c, task, before),
    };
    let live = matches!(task.status, Status::Running | Status::Review);
    let name = c.status[task.status.at()];
    let meta = match task.time.filter(|_| live) {
        Some(time) => format!("{name} \u{b7} {time}"),
        None => name.to_owned(),
    };
    let trailing = (!item.running).then(|| {
        let mut menu = OverflowActionMenu::new(format!("ssl-menu-{story}-{}", item.id), (c.menu_label)(&item.label))
            .item(OverflowItem::new(c.menu[0]).icon(Icon::Play));
        if place.count > 1 {
            menu = menu.item(OverflowItem::new(c.menu[1]).icon(Icon::Blocks));
        }
        menu.item(OverflowItem::new(c.menu[2]).icon(Icon::Trash2).destructive())
            .into_any_element()
    });
    StepSortableRowSlots {
        marker: Some(marker(&item.id, task.status, (!head).then_some(place.step_index), cx)),
        title: item.label.clone(),
        more: (place.count > 1 && !place.expanded).then(|| (c.more)(place.count - 1).into()),
        meta: Some(meta.into()),
        caption: Some(caption.into()),
        trailing,
    }
}

/// A live list: drags and keyboard moves apply their edits at once (`applyStepSortableEdit`).
fn demo(
    story: &'static str,
    lang: Lang,
    shape: Shape,
    preview: Option<StepSortableDragPreview>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = Rc::new(copy(lang));
    let (initial, tasks) = demo_chains(&c, shape);
    let key = format!("ssl-{story}-{lang:?}");
    let state = window.use_keyed_state(key.clone(), cx, |_, _| initial);
    let chains = state.read(cx).clone();
    let tasks = Rc::new(tasks);
    let render_chains = chains.clone();
    let mut list = StepSortableList::new(key, chains, move |item, place, _, cx| {
        row_slots(story, &c, (&render_chains, &tasks), (item, place), cx)
    })
    .on_edit(move |edit, _, cx| {
        state.update(cx, |chains, cx| {
            *chains = apply_step_sortable_edit(chains, edit);
            cx.notify();
        });
    });
    if lang == Lang::Ko {
        list = list.labels(ko_labels());
    }
    if let Some(preview) = preview {
        list = list.drag_preview(preview);
    }
    list.into_any_element()
}
