//! DS HistoryRow and HistoryGroup (HistoryRow.tsx / HistoryRow.module.css): one visit on one
//! dense line, a favicon (a globe when it is missing), the title with the muted host, and the
//! time at the end. Hovering the row, or focusing its actions, swaps the time for the row actions;
//! selection mode makes the row a check box. A group is a day of rows under a quiet heading.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, ImageSource, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement, RenderOnce, SharedString, Styled as _, StyledImage as _, Window,
    div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::clickable::Clickable;
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::icon::{IconSize, icon};
use crate::ui::layout::{Space, Stack};
use crate::ui::media_frame::{Load, resolve};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

type Open = Rc<dyn Fn(&mut Window, &mut App)>;
type Change = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// `min-width: 6ch` of the host: six digits of the row's face (about 0.55em each).
const HOST_MIN_EM: f32 = 3.3; // DS: HistoryRow.module.css:79
/// `flex: 0 10 auto`: the host gives way ten times faster than the title.
const HOST_SHRINK: f32 = 10.; // DS: HistoryRow.module.css:78

#[derive(IntoElement)]
pub struct HistoryRow {
    id: ElementId,
    url: SharedString,
    time: SharedString,
    title: Option<SharedString>,
    icon_src: Option<ImageSource>,
    on_open: Option<Open>,
    actions: Option<AnyElement>,
    selecting: bool,
    selected: bool,
    on_selected_change: Option<Change>,
}

impl HistoryRow {
    /// `row_id` is the stable id of the row (`rowId`); `url` the full address; `time` the visit
    /// time formatted for the locale ("8:27 PM", "오후 8:27").
    pub fn new(
        row_id: impl Into<ElementId>,
        url: impl Into<SharedString>,
        time: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: row_id.into(),
            url: url.into(),
            time: time.into(),
            title: None,
            icon_src: None,
            on_open: None,
            actions: None,
            selecting: false,
            selected: false,
            on_selected_change: None,
        }
    }

    /// The page title; empty (or the URL itself) shows the host and path once.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// The favicon; a missing or undecodable one shows a globe.
    pub fn icon_src(mut self, source: impl Into<ImageSource>) -> Self {
        self.icon_src = Some(source.into());
        self
    }

    /// The machine-readable visit time (`dateTime`). gpui has no `time` element, so nothing
    /// reads it; the builder keeps the React prop list whole.
    pub fn date_time(self, _date_time: impl Into<SharedString>) -> Self {
        self
    }

    /// Opens the page: a click or Enter on the row.
    pub fn on_open(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }

    /// Row actions (small icon buttons) that take the time column on hover or keyboard focus.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// Selection mode: the row is a check box and the actions hide.
    pub fn selecting(mut self, selecting: bool) -> Self {
        self.selecting = selecting;
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn on_selected_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_selected_change = Some(Rc::new(handler));
        self
    }
}

/// `splitAddress`: the host and the rest of a URL, as the address field shows them.
fn split_address(url: &str) -> (&str, &str) {
    let value = url.trim();
    let Some((_, rest)) = value.split_once("://") else {
        return (value, "");
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, path) = rest.split_at(end);
    if host.is_empty() {
        return (value, "");
    }
    (host, if path == "/" { "" } else { path })
}

/// The 14px check box of selection mode; the row is the check box, so it is decorative.
fn check_box(selected: bool, ds: &Ds) -> Div {
    let side = ds.len(Length::IconSizeSm);
    let el = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(side)
        .border(px(1.))
        .rounded(px(3.)) // DS: HistoryRow.module.css:93
        .text_color(ds.color(Color::PrimaryForeground));
    if selected {
        el.border_color(ds.color(Color::Primary))
            .bg(ds.color(Color::Primary))
            .child(icon(Icon::CheckIcon, IconSize::Xs, ds))
    } else {
        el.border_color(ds.color(Color::LineStrong))
    }
}

/// `SiteIcon`: the favicon in a 16px slot; the globe shows until it decodes, and when it never does.
fn site_icon(
    id: &ElementId,
    source: Option<&ImageSource>,
    window: &mut Window,
    cx: &mut App,
) -> Div {
    let data = source.and_then(|source| {
        match resolve(&(id.clone(), "favicon").into(), source, window, cx) {
            Load::Ready(data) => Some(data),
            _ => None,
        }
    });
    let ds = Ds::get(cx);
    let slot = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(ds.len(Length::IconSizeMd));
    match data {
        Some(data) => slot.child(
            gpui::img(ImageSource::Render(data))
                .size_full()
                .object_fit(gpui::ObjectFit::Contain),
        ),
        None => slot.text_color(ds.color(Color::TextTertiary)).child(icon(
            Icon::Globe2,
            IconSize::Md,
            ds,
        )),
    }
}

/// The title with the host after it, muted; the host gives way first.
fn text(label: SharedString, host: Option<SharedString>, ds: &Ds) -> Div {
    let title = div()
        .min_w_0()
        .flex_shrink(1.)
        .child(Typo::text(label).tone(Tone::Primary).truncate());
    let host = host.map(|host| {
        div()
            .min_w(ds.len(Length::FontSize2) * HOST_MIN_EM)
            .flex_shrink(HOST_SHRINK)
            .overflow_hidden()
            .child(Typo::text(host).tone(Tone::Tertiary).truncate())
    });
    div()
        .flex()
        .min_w_0()
        .items_baseline()
        .gap(ds.len(Length::SpaceSm))
        .overflow_hidden()
        .child(title)
        .children(host)
}

/// The end of the row: the time, and over it (same cell) the actions once the row is hovered
/// or the actions hold focus.
fn trail(
    row: &HistoryRow,
    actions: Option<AnyElement>,
    group: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Div {
    let time = Typo::caption(row.time.clone())
        .tone(Tone::Tertiary)
        .tabular()
        .wrap(Wrap::Nowrap);
    let end = |child: AnyElement| div().flex().justify_end().items_center().child(child);
    let Some(actions) = actions else {
        return div().flex().flex_none().child(end(time.into_any_element()));
    };
    let handle = window
        .use_keyed_state((row.id.clone(), "actions-focus"), cx, |_, cx| {
            cx.focus_handle()
        })
        .read(cx)
        .clone();
    let shown = handle.contains_focused(window, cx);
    let mut time_cell = end(time.into_any_element()).col_start(1).row_start(1);
    // ANIM-MIGRATE(the actions fade in over `--motion-fast` as the time hides)
    let mut actions_cell = end(actions)
        .id((row.id.clone(), "actions"))
        .track_focus(&focus::tab_stop(&handle, false))
        .col_start(1)
        .row_start(1)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
    if shown {
        time_cell = time_cell.invisible();
    } else {
        time_cell = time_cell.group_hover_style(group.clone(), gpui::Styled::invisible);
        actions_cell = actions_cell
            .opacity(0.)
            .group_hover_style(group.clone(), |style| style.opacity(1.));
    }
    div()
        .grid()
        .grid_cols(1)
        .flex_none()
        .child(time_cell)
        .child(actions_cell)
}

impl RenderOnce for HistoryRow {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (url_host, path) = split_address(&self.url);
        let host = SharedString::from(if url_host.is_empty() {
            self.url.to_string()
        } else {
            url_host.to_owned()
        });
        // A page without a title records its URL as the title; the address shows once.
        let named = self
            .title
            .clone()
            .filter(|t| !t.is_empty() && *t != self.url);
        let label = named
            .clone()
            .unwrap_or_else(|| format!("{host}{path}").into());
        let actions = self.actions.take().filter(|_| !self.selecting);
        let group = SharedString::from(format!("{}:group", self.id));
        let favicon = site_icon(&self.id, self.icon_src.as_ref(), window, cx);
        let trail = trail(&self, actions, &group, window, cx);
        let ds = Ds::get(cx);
        let mut lead = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(ds.len(Length::SpaceSm))
            .pr(ds.len(Length::SpaceMd));
        if self.selecting {
            lead = lead.child(check_box(self.selected, ds));
        }
        let lead = lead
            .child(favicon)
            .child(text(label, named.map(|_| host), ds));
        let line = div()
            .flex()
            .items_center()
            .w_full()
            .min_w_0()
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeightTight))
            .child(lead)
            .child(trail);
        let (selecting, selected) = (self.selecting, self.selected);
        let (on_open, on_change) = (self.on_open, self.on_selected_change);
        let main = Clickable::new((self.id.clone(), "main"))
            .stretch()
            .metrics(ds.len(Length::SpaceSm), ds.len(Length::ControlHeightLg))
            .on_click(move |_: &ClickEvent, window, cx| {
                if selecting {
                    if let Some(change) = &on_change {
                        change(!selected, window, cx);
                    }
                } else if let Some(open) = &on_open {
                    open(window, cx);
                }
            })
            .child(line);
        let row = div()
            .group(group)
            .w_full()
            .min_w_0()
            .rounded(ds.len(Length::RadiusControl))
            .child(main);
        if selecting && selected {
            row.bg(ds.color(Color::Selection))
        } else {
            row
        }
    }
}

#[derive(IntoElement)]
pub struct HistoryGroup {
    title: SharedString,
    children: Vec<AnyElement>,
}

impl HistoryGroup {
    /// `title` is the day ("Today - Sunday, October 11"), formatted for the locale.
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            children: Vec::new(),
        }
    }
}

impl ParentElement for HistoryGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for HistoryGroup {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        Stack::new()
            .gap(Space::Xs)
            .child(
                div().px(ds.len(Length::SpaceSm)).child(
                    Typo::label(self.title)
                        .weight(Weight::Semibold)
                        .tone(Tone::Secondary),
                ),
            )
            .child(div().flex().flex_col().min_w_0().children(self.children))
    }
}
