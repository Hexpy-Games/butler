//! Stand-ins for the content the shell showcases put in their slots: blocks of later batches
//! (KeyValueRow, EmptyLine, Section, MessageRow, the browser pane, the file viewer, the sidebar
//! of the demo window). Each draws from tokens and follows the React CSS it replaces; they go
//! away when the blocks land and are not part of `butler-ds`.
use butler_ds::tokens::{Color, Length, Number};
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::typo::{Role, Tone, Typo, Weight};
use gpui::{
    AnyElement, App, FontWeight, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    div, px,
};

use butler_ds::ui::blocks::nav_row::NavRow;

/// KeyValueRow (KeyValueRow.module.css): a label and its value on one baseline row, and under
/// them an optional description and meta.
pub(crate) fn key_value_row(
    label: &'static str,
    value: &'static str,
    meta: Option<&'static str>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let main = Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Baseline)
        .gap(Space::Sm)
        .min_width(MinWidth::Zero)
        .child(
            div()
                .min_w_0()
                .child(Typo::caption(label).tone(Tone::Tertiary)),
        )
        .child(
            div()
                .min_w_0()
                .text_right()
                .font_family(ds.body_font().clone())
                .text_size(ds.len(Length::FontSize3))
                .line_height(ds.len(Length::TypoBodyLineHeight))
                .text_color(ds.color(Color::TextPrimary))
                .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
                .child(value),
        );
    let detail = meta.map(|meta| {
        Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Sm)
            .min_width(MinWidth::Zero)
            .child(
                div()
                    .flex_none()
                    .child(Typo::caption(meta).tone(Tone::Tertiary)),
            )
    });
    div()
        .flex()
        .flex_col()
        .min_h(px(28.)) // DS: KeyValueRow.module.css:9
        .py(px(2.)) // DS: KeyValueRow.module.css:10
        .gap(ds.len(Length::SpaceXs))
        .min_w_0()
        .child(main)
        .children(detail)
        .into_any_element()
}

/// EmptyLine (EmptyLine.module.css): a centred, dimmed icon above a message.
pub(crate) fn empty_line(glyph: Icon, message: &'static str, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let rows = Stack::new()
        .gap(Space::Md)
        .cross(Cross::Center)
        .child(
            div()
                .flex()
                .opacity(0.6) // DS: EmptyLine.module.css:17
                .text_color(ds.color(Color::TextTertiary))
                .child(icon(glyph, IconSize::Md, ds)),
        )
        .child(
            Typo::body(message)
                .tone(Tone::Secondary)
                .align(butler_ds::ui::typo::TextAlign::Center),
        );
    div()
        .w_full()
        .p(ds.len(Length::Space2xl))
        .child(rows)
        .into_any_element()
}

/// Section (Section.module.css): a title row over its content, `gap` apart.
pub(crate) fn section(title: &'static str, gap: Space, children: Vec<AnyElement>) -> AnyElement {
    Stack::new()
        .gap(Space::Lg)
        .child(
            Stack::new().gap(Space::Sm).child(
                Stack::row()
                    .justify(Justify::Between)
                    .cross(Cross::Center)
                    .gap(Space::Md)
                    .child(Typo::new(Role::PanelSectionTitle, title).tone(Tone::Primary)),
            ),
        )
        .child(Stack::new().gap(gap).children(children))
        .into_any_element()
}

/// MessageRow's user bubble and assistant text (MessageRow.module.css `.user`, `.assistant`).
pub(crate) fn message_row(user: bool, text: &'static str, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let body = Typo::body(text).weight(Weight::Regular);
    let content = div().font_size_like(ds).child(body);
    if user {
        div()
            .flex()
            .justify_end()
            .pb(px(18.)) // DS: MessageRow.module.css:9
            .child(
                div()
                    .max_w(gpui::relative(0.68))
                    .rounded(ds.len(Length::RadiusPopover))
                    .bg(ds.color(Color::UserMessageBg))
                    .px(px(10.))
                    .py(px(6.)) // DS: MessageRow.module.css:63
                    .child(content),
            )
            .into_any_element()
    } else {
        div()
            .pb(px(26.)) // DS: MessageRow.module.css:19
            .child(div().pt(px(2.)).pb(ds.len(Length::SpaceXs)).child(content))
            .into_any_element()
    }
}

trait BodyLike {
    fn font_size_like(self, ds: &Ds) -> Self;
}

impl BodyLike for gpui::Div {
    fn font_size_like(self, ds: &Ds) -> Self {
        self.text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeightDocument))
    }
}

/// The nav rows and spaces of the demo window's sidebar (BrowserPane fixtures `DemoSidebar`).
pub(crate) fn demo_sidebar_rows(
    cx: &App,
    names: &[&'static str],
    spaces: &'static str,
    rows: &[&'static str],
) -> Vec<AnyElement> {
    let glyphs = [
        Icon::PencilLine,
        Icon::Search,
        Icon::Clock3,
        Icon::Globe2,
        Icon::Library,
    ];
    let nav = Stack::new()
        .gap(Space::Xs)
        .children(names.iter().zip(glyphs).map(|(label, glyph)| {
            NavRow::new(SharedString::from(format!("nav-{label}")), *label)
                .glyph(glyph)
                .on_click(|_, _, _| {})
        }));
    let list = Stack::new()
        .gap(Space::Xs)
        .child(
            div()
                .min_h(Ds::get(cx).len(Length::SidebarActionSize))
                .flex()
                .items_center()
                .child(Typo::label(spaces).tone(Tone::Tertiary)),
        )
        .children(rows.iter().enumerate().map(|(index, label)| {
            let row = NavRow::new(SharedString::from(format!("space-{label}")), *label)
                .glyph(Icon::MessageSquare)
                .on_click(|_, _, _| {});
            if index == 0 { row.active() } else { row }
        }));
    vec![
        Stack::new()
            .gap(Space::Lg)
            .child(nav)
            .child(list)
            .into_any_element(),
    ]
}
