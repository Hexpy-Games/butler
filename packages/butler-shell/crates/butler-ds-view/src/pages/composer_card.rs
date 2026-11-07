//! ComposerCard.showcase.tsx: the product composer (editor, toolbar controls, context donut and
//! send) in its states. The editor is a DS Textarea in the card's slot (the app's rich-text editor
//! is the app's); the shoreline and cherry decorations' live wallpaper art is not drawn (the
//! card's decoration slot is), so those two stories show the card with its edge character.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_card::{
    CompactPreview, ComposerCard, Edge, EdgeKind, ExpandedBody, ExpandedControls, PlanToggle,
    SendButton, SendMode, Toolbar, ToolbarSpacer, textarea,
};
use butler_ds::ui::blocks::composer_control::{Compact, ComposerControl};
use butler_ds::ui::blocks::context_donut_button::ContextDonutButton;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::scope::{Spec, scoped};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div, px,
};

use super::{Story, sub};
use crate::app::conversation_bg;
use crate::copy::Lang;

struct Copy {
    placeholder: &'static str,
    follow_up: &'static str,
    more: &'static str,
    plan: &'static str,
    access: &'static str,
    model: &'static str,
    draft: &'static str,
    preview: &'static str,
    optional: &'static str,
    no_images: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            placeholder: "Ask Butler anything",
            follow_up: "Ask for follow-up changes",
            more: "More options",
            plan: "Plan",
            access: "Ask",
            model: "GPT-5.1",
            draft: "Summarize the motion tokens and list the components that still declare their own transitions.",
            preview: "Summarize the motion tokens…",
            optional: "Web search is off. Turn it on in Settings to cite sources.",
            no_images: "Model doesn't accept images",
        },
        Copy {
            placeholder: "버틀러에게 무엇이든 물어보세요",
            follow_up: "후속 변경사항 요청",
            more: "추가 기능",
            plan: "계획",
            access: "질문",
            model: "GPT-5.1",
            draft: "모션 토큰을 요약하고 아직 자체 전환을 선언하는 컴포넌트를 나열해 주세요.",
            preview: "모션 토큰을 요약하고…",
            optional: "웹 검색이 꺼져 있습니다. 출처를 인용하려면 설정에서 켜세요.",
            no_images: "이미지 미지원 모델",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "New chat (large)",
            render: |lang, window, cx| composer(lang, Opts::new("cc-large").large(), window, cx),
        },
        Story {
            name: "New chat with the shoreline decoration",
            render: |lang, window, cx| decorated(lang, EdgeKind::Crab, window, cx),
        },
        Story {
            name: "New chat with the cherry decoration",
            render: |lang, window, cx| decorated(lang, EdgeKind::Cat, window, cx),
        },
        Story {
            name: "Narrow conversation column (340 and 400px)",
            render: narrow,
        },
        Story {
            name: "Follow-up while a turn runs (stop)",
            render: |lang, window, cx| {
                composer(lang, Opts::new("cc-stop").mode(SendMode::Stop), window, cx)
            },
        },
        Story {
            name: "Reconnecting (busy send)",
            render: |lang, window, cx| composer(lang, Opts::new("cc-busy").busy(), window, cx),
        },
        Story {
            name: "Send blocked (text-only model)",
            render: |lang, window, cx| {
                composer(lang, Opts::new("cc-blocked").blocked(), window, cx)
            },
        },
        Story {
            name: "Folded preview, drop target and notice",
            render: folded,
        },
    ]
}

#[derive(Clone, Copy)]
struct Opts {
    id: &'static str,
    large: bool,
    mode: SendMode,
    busy: bool,
    blocked: bool,
    edge: Option<EdgeKind>,
}

impl Opts {
    fn new(id: &'static str) -> Self {
        Self {
            id,
            large: false,
            mode: SendMode::Send,
            busy: false,
            blocked: false,
            edge: None,
        }
    }

    fn large(mut self) -> Self {
        self.large = true;
        self
    }

    fn mode(mut self, mode: SendMode) -> Self {
        self.mode = mode;
        self
    }

    fn busy(mut self) -> Self {
        self.busy = true;
        self
    }

    fn blocked(mut self) -> Self {
        self.blocked = true;
        self
    }

    fn edge(mut self, kind: EdgeKind) -> Self {
        self.edge = Some(kind);
        self
    }
}

/// The product composer: editor, toolbar controls, context donut and send.
fn composer(lang: Lang, o: Opts, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let plan = window.use_keyed_state(sub(o.id, "plan"), cx, |_, _| false);
    let draft = window.use_keyed_state(sub(o.id, "draft"), cx, |_, _| String::new());
    let empty = draft.read(cx).is_empty();
    let (set_plan, set_draft) = (plan.clone(), draft.clone());
    let ds = Ds::get(cx);
    let mut card = ComposerCard::new(o.id);
    if o.large {
        card = card.large();
    }
    if let Some(kind) = o.edge {
        card = card.edge(Edge::character(kind));
    }
    let mut send = SendButton::new(sub(o.id, "send")).mode(o.mode);
    if o.busy {
        send = send.busy();
    } else if o.mode == SendMode::Send && empty {
        send = send.disabled();
    }
    if o.blocked {
        send = send.disabled_reason(c.no_images);
    }
    card.child(
        ExpandedBody::new(sub(o.id, "body")).child(
            textarea(sub(o.id, "editor"))
                .rows(1)
                .placeholder(if o.large { c.placeholder } else { c.follow_up })
                .on_change(move |text, _, cx| {
                    let text = text.to_owned();
                    set_draft.update(cx, |draft, cx| {
                        *draft = text;
                        cx.notify();
                    });
                }),
        ),
    )
    .child(
        Toolbar::new()
            .child(IconButton::new(sub(o.id, "more"), c.more).icon(icon(
                Icon::Plus,
                IconSize::Md,
                ds,
            )))
            .child(
                ExpandedControls::new()
                    .child(
                        ComposerControl::new(sub(o.id, "access"), c.access)
                            .icon(icon(Icon::ShieldQuestion, IconSize::Sm, ds))
                            .compact(Compact::Label),
                    )
                    .child(
                        PlanToggle::new(sub(o.id, "plan"), *plan.read(cx), c.plan)
                            .on_checked_change(move |value, _, cx| {
                                set_plan.update(cx, |plan, cx| {
                                    *plan = value;
                                    cx.notify();
                                });
                            }),
                    )
                    .child(ToolbarSpacer)
                    .child(ContextDonutButton::new(sub(o.id, "donut"), 0.42))
                    .child(
                        ComposerControl::new(sub(o.id, "model"), c.model)
                            .icon(icon(Icon::AiChip, IconSize::Sm, ds))
                            .detail("medium"),
                    ),
            )
            .child(send),
    )
    .into_any_element()
}

/// One decorated composer on a theme's conversation background.
#[derive(IntoElement)]
struct Tone {
    child: Option<AnyElement>,
}

impl RenderOnce for Tone {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .p(ds.len(Length::Space3))
            .rounded(ds.len(Length::RadiusPanel))
            .bg(conversation_bg(ds))
            .text_color(ds.color(Color::TextPrimary))
            .children(self.child)
    }
}

/// The decorated new-chat composer in both themes.
fn decorated(lang: Lang, kind: EdgeKind, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let gap = ds.len(Length::Space3);
    let tone = |dark: bool, key: &'static str, window: &mut Window, cx: &mut App| {
        let child = composer(lang, Opts::new(key).large().edge(kind), window, cx);
        scoped(
            Spec {
                dark: Some(dark),
                ..Spec::default()
            },
            Tone { child: Some(child) },
        )
    };
    let light = tone(false, "cc-light", window, cx);
    let dark = tone(true, "cc-dark", window, cx);
    div()
        .flex()
        .flex_col()
        .gap(gap)
        .child(light)
        .child(dark)
        .into_any_element()
}

/// Composers at the widths of a conversation column beside the browser pane.
fn narrow(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let gap = ds.len(Length::Space3);
    let first = composer(lang, Opts::new("cc-narrow-316"), window, cx);
    let second = composer(lang, Opts::new("cc-narrow-376"), window, cx);
    div()
        .flex()
        .flex_col()
        .gap(gap)
        .child(div().w_full().max_w(px(316.)).child(first))
        .child(div().w_full().max_w(px(376.)).child(second))
        .into_any_element()
}

/// A folded card with a drop target and a notice.
fn folded(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    ComposerCard::new("cc-folded")
        .drop_active()
        .expanded(false)
        .large()
        .notice(Notice::new(NoticeTone::Warning, c.optional))
        .child(
            ExpandedBody::new("cc-folded-body")
                .child(textarea("cc-folded-editor").default_value(c.draft).rows(1)),
        )
        .child(
            Toolbar::new()
                .child(IconButton::new("cc-folded-more", c.more).icon(icon(
                    Icon::Plus,
                    IconSize::Md,
                    ds,
                )))
                .child(CompactPreview::new("cc-folded-preview", c.preview))
                .child(SendButton::new("cc-folded-send")),
        )
        .into_any_element()
}
