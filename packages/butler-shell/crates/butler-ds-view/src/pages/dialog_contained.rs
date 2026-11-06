//! Dialog.contained.demo.tsx and Dialog.fullHeight.demo.tsx: a dialog anchored in a page card.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Layout,
    Size as DialogSize,
};
use butler_ds::ui::layout::{Box as DsBox, Radius, Space, Stack, Surface};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, Pixels, Styled as _, Window, div, px,
};

use crate::copy::Lang;

struct Copy {
    page: &'static str,
    title: &'static str,
    host: &'static str,
    message: &'static str,
    cancel: &'static str,
    ok: &'static str,
    show: &'static str,
    graph_page: &'static str,
    graph_title: &'static str,
    graph_description: &'static str,
    empty: &'static str,
    close: &'static str,
    open: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            page: "shop.example.com · checkout",
            title: "Page message",
            host: "shop.example.com",
            message: "Cancel this order? The coupon can't be returned.",
            cancel: "Cancel",
            ok: "OK",
            show: "Show again",
            graph_page: "Project · Work",
            graph_title: "Task graph",
            graph_description: "Delegated work and how it connects.",
            empty: "No delegated work yet.",
            close: "Close",
            open: "Open in the window",
        },
        Copy {
            page: "shop.example.com · 결제",
            title: "페이지 메시지",
            host: "shop.example.com",
            message: "주문을 취소할까요? 취소하면 쿠폰은 돌려받을 수 없어요.",
            cancel: "취소",
            ok: "확인",
            show: "다시 보기",
            graph_page: "프로젝트 · 작업",
            graph_title: "작업 그래프",
            graph_description: "맡긴 작업과 그 연결.",
            empty: "아직 맡긴 작업이 없습니다.",
            close: "닫기",
            open: "창에서 열기",
        },
    )
}

/// The page card the dialog is anchored in: `position: relative; overflow: hidden`, a hairline
/// border, `--radius-popover`. Returns the card and its inner corner radius.
fn card(height: f32, label: &'static str, ds: &Ds) -> (gpui::Div, Pixels) {
    let radius = ds.len(Length::RadiusPopover);
    let page = div()
        .size_full()
        .bg(ds.color(Color::SurfaceRaised))
        .p(ds.len(Length::SpaceMd))
        .child(Typo::caption(label).tone(Tone::Secondary));
    let card = div()
        .relative()
        .h(px(height))
        .overflow_hidden()
        .rounded(radius)
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(page);
    (card, radius - ds.len(Length::BorderHairline))
}

/// A page's own dialog (confirm, sign-in) anchored in the page card: the scrim covers only the
/// card, the rest of the window stays usable, and page text is quoted under a Butler title.
pub(super) fn anchored(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-contained", window, cx)
        .modal(false)
        .default_open(window, cx);
    let (card, radius) = card(300., c.page, Ds::get(cx));
    let close = |id: &'static str, variant, text: &'static str| {
        Button::new(id)
            .size(Size::Sm)
            .variant(variant)
            .text(text)
            .on_click(dialog.closer().on_click())
    };
    let footer = DialogFooter::new()
        .child(close("dialog-contained-cancel", Variant::Outline, c.cancel))
        .child(close("dialog-contained-ok", Variant::Default, c.ok));
    let message = DsBox::new()
        .surface(Surface::Muted)
        .radius(Radius::Control)
        .padding(Space::Md)
        .child(Typo::body(c.message));
    let content = dialog.content(
        DialogContent::new()
            .show_close_button(false)
            .contained(radius)
            .header(
                DialogHeader::new()
                    .child(DialogTitle::new(c.title))
                    .child(DialogDescription::new(c.host)),
            )
            .child(message)
            .footer(footer),
        window,
        cx,
    );
    let open = dialog.is_open(cx);
    let show = (!open).then(|| show_again(&dialog, "dialog-contained-show", c.show));
    Stack::new()
        .gap(Space::Sm)
        .child(card.child(dialog.container_probe()).child(content))
        .children(show)
        .into_any_element()
}

fn show_again(dialog: &Dialog, id: &'static str, text: &'static str) -> AnyElement {
    let dialog = dialog.clone();
    Button::new(id)
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(text)
        .on_click(move |_, window, cx| dialog.set_open(true, window, cx))
        .into_any_element()
}

/// The graph dialog: header, a nearly empty ScrollArea fill and the footer.
fn graph(dialog: &Dialog, c: &Copy, contained: Option<Pixels>, ds: &Ds) -> DialogContent {
    let empty = div()
        .w_full()
        .p(ds.len(Length::Space2xl))
        .flex()
        .flex_col()
        .items_center()
        .child(Typo::body(c.empty).tone(Tone::Secondary));
    let close = Button::new("dialog-graph-close")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(c.close)
        .on_click(dialog.closer().on_click());
    let mut content = DialogContent::new()
        .size(DialogSize::Full)
        .layout(Layout::ScrollBody)
        .full_height()
        .header(
            DialogHeader::new()
                .child(DialogTitle::new(c.graph_title))
                .child(DialogDescription::new(c.graph_description)),
        )
        .child(ScrollArea::new("dialog-graph-scroll").fill().child(empty))
        .footer(DialogFooter::new().child(close));
    if let Some(radius) = contained {
        content = content.contained(radius);
    }
    content
}

/// `height="full"`: a scroll-body dialog whose body is nearly empty still fills its cap (here a
/// page card; from the button, the window) instead of collapsing to a strip.
pub(super) fn full_height(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let card_dialog = Dialog::new("dialog-full-card", window, cx)
        .modal(false)
        .default_open(window, cx);
    let window_dialog = Dialog::new("dialog-full-window", window, cx);
    let (card, radius) = card(360., c.graph_page, Ds::get(cx));
    let in_card = graph(&card_dialog, &c, Some(radius), Ds::get(cx));
    let in_window = graph(&window_dialog, &c, None, Ds::get(cx));
    let in_card = card_dialog.content(in_card, window, cx);
    let in_window = window_dialog.content(in_window, window, cx);
    let open = window_dialog.trigger(|toggle| {
        Button::new("dialog-full-open")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(c.open)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let show =
        (!card_dialog.is_open(cx)).then(|| show_again(&card_dialog, "dialog-full-show", c.show));
    Stack::new()
        .gap(Space::Sm)
        .child(card.child(card_dialog.container_probe()).child(in_card))
        .child(
            Stack::row()
                .gap(Space::Sm)
                .children(show)
                .child(open)
                .child(in_window),
        )
        .into_any_element()
}
