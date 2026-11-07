//! ComposerDecisionPanel.showcase.tsx (+ showcaseParts): a pending decision in place of the
//! composer input, in the composer and in the conversation. The page thumbnails of the browser
//! stories are a flat mock page: the live tab frame is a browser-pane (P5) block.
use butler_ds::tokens::Color;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_card::ComposerCard;
use butler_ds::ui::blocks::composer_decision_panel::{
    Action, ComposerDecisionPanel, Detail, Media,
};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::split_button::{SplitButton, SplitItem, SplitSize};
use butler_ds::ui::button::Variant;
use butler_ds::ui::context::Ds;
use butler_ds::ui::convert;
use butler_ds::ui::overlay::place::Side;
use butler_ds::ui::tag::{Tag, Tone};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, Styled as _, Window, div, px, relative,
};

use super::{Story, sub};
use crate::copy::Lang;

struct Copy {
    plan: &'static str,
    instruction: &'static str,
    reject: &'static str,
    accept: &'static str,
    authority: &'static str,
    deny: &'static str,
    once: &'static str,
    conversation: &'static str,
    error: &'static str,
    rename: &'static str,
    more: &'static str,
    show_more: &'static str,
    show_less: &'static str,
    medium: &'static str,
    command: &'static str,
    high: &'static str,
    memory: &'static str,
    reread: &'static str,
    memory_input: &'static str,
    eyebrow_plan: &'static str,
    eyebrow_permission: &'static str,
    click: &'static str,
    click_detail: &'static str,
    network: &'static str,
    open_tab: &'static str,
    tab_title: &'static str,
    handoff: [&'static str; 4],
    handoff_tab: &'static str,
    handoff_title: &'static str,
    mfa: &'static str,
    open_to_check: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            plan: "Design system final cleanup plan: remove product CSS modules and verify pixel equivalence end to end",
            instruction: "Add instruction",
            reject: "Keep planning",
            accept: "Accept plan",
            authority: "Allow writing files outside the workspace",
            deny: "Deny",
            once: "Allow once",
            conversation: "Always allow in this conversation",
            error: "Could not submit the decision. Try again.",
            rename: "Edit 24 files in 'Desktop'?",
            more: "+21 more",
            show_more: "Show more",
            show_less: "Show less",
            medium: "Medium risk",
            command: "Run a command in 'garden'?",
            high: "High risk",
            memory: "Save or change an instruction?",
            reread: "Butler just read outside content, so it asks again.",
            memory_input: "{\"kind\":\"instruction\",\"text\":\"From now on, check the amount and deadline first on quote mails from vendors, and tell me right away when an amount rises more than 10% over the previous quote. Always draft replies politely, and list attachment names and sizes as well. Reflect this in the morning report too.\",\"duration\":\"always\",\"source\":\"Connected mail\"}",
            eyebrow_plan: "Plan",
            eyebrow_permission: "Permission",
            click: "Click ‘Book now’",
            click_detail: "Pine Grove Campground · Oct 20 and 22, deck site, 2 nights · $84",
            network: "Run a networked command in 'garden'?",
            open_tab: "Open tab",
            tab_title: "Pine Grove Campground · Booking",
            handoff: ["Browser", "Sign-in needs you", "Finish in the tab, then give it back to Butler", "Stop task"],
            handoff_tab: "Riverside · Two-step verification",
            handoff_title: "Riverside Campground · Site map",
            mfa: "Two-step verification",
            open_to_check: "Open to check",
        },
        Copy {
            plan: "디자인 시스템 최종 정리 계획: 제품 CSS 모듈 제거와 픽셀 동등성 검증까지 한 번에 진행",
            instruction: "지시 추가",
            reject: "계속 계획",
            accept: "계획 승인",
            authority: "워크스페이스 밖의 파일 쓰기 허용 요청",
            deny: "거절",
            once: "이번만 허용",
            conversation: "이 대화에서 계속 허용",
            error: "결정을 전달하지 못했습니다.",
            rename: "'Desktop'의 파일 24개를 수정할까요?",
            more: "외 21개",
            show_more: "더보기",
            show_less: "접기",
            medium: "위험 보통",
            command: "'garden'에서 명령을 실행할까요?",
            high: "위험 높음",
            memory: "지침 저장 · 변경 허용할까요?",
            reread: "방금 외부에서 가져온 내용을 읽어서 다시 확인합니다.",
            memory_input: "{\"kind\":\"instruction\",\"text\":\"다음부터 거래처에서 오는 견적 메일은 금액과 마감일을 먼저 확인하고, 금액이 지난 견적보다 10% 넘게 오르면 바로 알려 주세요. 회신 초안은 항상 정중한 존댓말로 쓰고, 첨부 파일 이름과 크기도 함께 정리해 주세요. 이 지침은 매일 오전 보고에도 반영해 주세요.\",\"duration\":\"always\",\"source\":\"연결된 메일\"}",
            eyebrow_plan: "계획",
            eyebrow_permission: "권한",
            click: "‘예약하기’ 버튼 클릭",
            click_detail: "가평 솔숲 캠핑장 · 10월 20일, 22일 데크 2박 · 110,000원",
            network: "'garden'에서 네트워크 명령을 실행할까요?",
            open_tab: "탭 열기",
            tab_title: "가평 솔숲 캠핑장 · 예약",
            handoff: ["브라우저", "로그인 확인 필요", "탭에서 마친 뒤 버틀러에게 돌려주세요", "작업 중지"],
            handoff_tab: "강변 캠핑장 · 2단계 인증",
            handoff_title: "양평 강변 캠핑장 · 사이트 안내",
            mfa: "2단계 인증",
            open_to_check: "열어서 확인",
        },
    )
}

const SCREENSHOTS: [&str; 3] = [
    "Screenshot 2026-09-27 at 10.02.14.png",
    "Screenshot 2026-09-27 at 10.05.31.png",
    "Screenshot 2026-09-27 at 10.09.02.png",
];

const SCRIPT: &str = "python3 -c '\nimport json, urllib.request\n\ndef fetch(url):\n    with urllib.request.urlopen(url, timeout=10) as resp:\n        for item in json.load(resp).get(\"items\", []):\n            if item.get(\"score\", 0) > 10:\n                print(item[\"title\"], item[\"url\"], item.get(\"summary\", \"\"), sep=\" | \")\n\nfetch(\"https://api.example.com/v1/items?limit=20\")\n'";

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Plan decision",
            render: |l, _, c| in_card("dp-plan", plan(l, "dp-plan", Placement::Composer), c),
        },
        Story {
            name: "Approval request",
            render: |l, _, c| {
                in_card(
                    "dp-approval",
                    approval(l, "dp-approval", Placement::Composer),
                    c,
                )
            },
        },
        Story {
            name: "High-risk command",
            render: |l, _, c| in_card("dp-command", command(l), c),
        },
        Story {
            name: "Command body in a code frame",
            render: |l, _, c| in_card("dp-script", script(l), c),
        },
        Story {
            name: "Long reviewed input",
            render: |l, _, c| in_card("dp-long", long_input(l), c),
        },
        Story {
            name: "Authority decision",
            render: |l, _, c| in_card("dp-authority", authority(l, false), c),
        },
        Story {
            name: "Failed decision",
            render: |l, _, c| in_card("dp-failed", authority(l, true), c),
        },
        Story {
            name: "Browser approval with the page",
            render: |l, _, c| {
                in_card(
                    "dp-browser",
                    browser_approval(l, "dp-browser", Placement::Composer),
                    c,
                )
            },
        },
        Story {
            name: "Browser hand-off with the page",
            render: |l, _, c| in_card("dp-handoff", handoff(l), c),
        },
        Story {
            name: "In conversation · approval request",
            render: |l, _, _| {
                approval(l, "dp-conv-approval", Placement::Conversation).into_any_element()
            },
        },
        Story {
            name: "In conversation · plan decision",
            render: |l, _, _| plan(l, "dp-conv-plan", Placement::Conversation).into_any_element(),
        },
        Story {
            name: "In conversation · browser approval",
            render: |l, _, _| {
                browser_approval(l, "dp-conv-browser", Placement::Conversation).into_any_element()
            },
        },
        Story {
            name: "Keyboard · explicit confirmation",
            render: keyboard,
        },
    ]
}

/// `<ComposerCard>` around the panel.
fn in_card(id: &'static str, panel: ComposerDecisionPanel, _: &mut App) -> AnyElement {
    ComposerCard::new(sub(id, "card"))
        .child(panel)
        .into_any_element()
}

fn tag(id: &'static str, tone: Tone, text: &'static str) -> Tag {
    Tag::new(id, text).tone(tone)
}

/// Deny, then the split "Allow once" button with the conversation scope in its menu.
fn authority_actions(
    panel: ComposerDecisionPanel,
    c: &Copy,
    id: &'static str,
) -> ComposerDecisionPanel {
    panel
        .action(Action::new(c.deny, Variant::Secondary, |_, _| {}))
        .custom_action(
            SplitButton::new(format!("{id}-split"), c.once, |_, _, _| {})
                .size(SplitSize::Sm)
                .menu_side(Side::Top)
                .item(SplitItem::new(c.conversation, |_, _| {})),
        )
}

fn plan(lang: Lang, id: &'static str, placement: Placement) -> ComposerDecisionPanel {
    let c = copy(lang);
    ComposerDecisionPanel::new(id, Icon::ListChecks, c.plan, |_, _, _| {})
        .eyebrow(c.eyebrow_plan)
        .placement(placement)
        .action(Action::new(c.instruction, Variant::Outline, |_, _| {}))
        .action(Action::new(c.reject, Variant::Secondary, |_, _| {}))
        .action(Action::new(c.accept, Variant::Default, |_, _| {}))
}

fn approval(lang: Lang, id: &'static str, placement: Placement) -> ComposerDecisionPanel {
    let c = copy(lang);
    let details = SCREENSHOTS
        .iter()
        .map(|name| Detail::line(*name))
        .chain([Detail::line(c.more)]);
    let panel = ComposerDecisionPanel::new(id, Icon::Folder, c.rename, |_, _, _| {})
        .eyebrow(c.eyebrow_permission)
        .placement(placement)
        .details(details)
        .literal()
        .details_labels(c.show_more, c.show_less)
        .aside(tag("dp-approval-risk", Tone::Warning, c.medium));
    authority_actions(panel, &c, id)
}

fn command(lang: Lang) -> ComposerDecisionPanel {
    let c = copy(lang);
    let line = format!(
        "magick shot.png -resize 2876x6 build/a->b.png && npm run build -- --out {}and a long tail of arguments that wraps",
        "dist/".repeat(16)
    );
    let panel = ComposerDecisionPanel::new("dp-command", Icon::Terminal, c.command, |_, _, _| {})
        .eyebrow(c.eyebrow_permission)
        .details([Detail::line(line)])
        .literal()
        .details_labels(c.show_more, c.show_less)
        .aside(tag("dp-command-risk", Tone::Danger, c.high));
    authority_actions(panel, &c, "dp-command")
}

fn script(lang: Lang) -> ComposerDecisionPanel {
    let c = copy(lang);
    ComposerDecisionPanel::new("dp-script", Icon::Globe2, c.network, |_, _, _| {})
        .eyebrow(c.eyebrow_permission)
        .details([Detail::code(SCRIPT), Detail::line("garden")])
        .literal()
        .aside(tag("dp-script-risk", Tone::Danger, c.high))
        .action(Action::new(c.deny, Variant::Secondary, |_, _| {}))
        .action(Action::new(c.once, Variant::Default, |_, _| {}))
}

fn long_input(lang: Lang) -> ComposerDecisionPanel {
    let c = copy(lang);
    let panel = ComposerDecisionPanel::new("dp-long", Icon::ShieldCheck, c.memory, |_, _, _| {})
        .eyebrow(c.eyebrow_permission)
        .details([
            Detail::line(c.reread),
            Detail::line("update_explicit_memory"),
            Detail::line(c.memory_input),
        ])
        .details_labels(c.show_more, c.show_less)
        .aside(tag("dp-long-risk", Tone::Warning, c.medium));
    authority_actions(panel, &c, "dp-long")
}

fn authority(lang: Lang, failed: bool) -> ComposerDecisionPanel {
    let c = copy(lang);
    let id = if failed { "dp-failed" } else { "dp-authority" };
    let mut panel = ComposerDecisionPanel::new(id, Icon::ShieldCheck, c.authority, |_, _, _| {})
        .eyebrow(c.eyebrow_permission)
        .aside(Typo::caption("+2"));
    if failed {
        panel = panel.error(c.error);
    }
    authority_actions(panel, &c, id)
}

/// A flat 16:10 mock page: a header, a hero picture, text lines and a call-to-action ringed in
/// amber while it waits for approval.
fn page_mock(ring: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let ink = ds.color(Color::TextPrimary);
    let bar =
        |w: f32, h: f32, shade: gpui::Hsla| div().w(relative(w)).h(px(h)).rounded(px(4.)).bg(shade);
    let soft = gpui::hsla(0., 0., 0.85, 1.);
    let green = gpui::hsla(0.37, 0.4, 0.37, 1.);
    let cta = div().w(relative(0.3)).h(px(18.)).rounded(px(4.)).bg(green);
    let cta = if ring {
        div()
            .p(px(2.))
            .rounded(px(6.))
            .border(px(2.))
            .border_color(gpui::hsla(0.12, 1., 0.45, 1.))
            .w(relative(0.34))
            .child(cta.w_full())
            .into_any_element()
    } else {
        cta.into_any_element()
    };
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .w_full()
        .h(px(90.))
        .p(px(8.))
        .bg(gpui::white())
        .child(bar(0.5, 6., convert::with_alpha(ink, 0.7)))
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    div()
                        .w(relative(0.5))
                        .h(px(40.))
                        .rounded(px(4.))
                        .bg(convert::with_alpha(green, 0.8)),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(5.))
                        .w(relative(0.4))
                        .child(bar(1., 5., soft))
                        .child(bar(0.7, 5., soft))
                        .child(cta),
                ),
        )
        .child(bar(0.6, 5., soft))
        .into_any_element()
}

fn browser_approval(lang: Lang, id: &'static str, placement: Placement) -> ComposerDecisionPanel {
    let c = copy(lang);
    let panel = ComposerDecisionPanel::new(id, Icon::ShieldCheck, c.click, |_, _, _| {})
        .eyebrow(c.eyebrow_permission)
        .placement(placement)
        .details([Detail::line(c.click_detail)])
        .aside(tag("dp-browser-risk", Tone::Warning, c.medium))
        .media(
            Media::new(
                BrowserPage { ring: true },
                format!("{} · {}", c.open_tab, c.tab_title),
            )
            .on_open(|_, _, _| {}),
        );
    authority_actions(panel, &c, id)
}

fn handoff(lang: Lang) -> ComposerDecisionPanel {
    let c = copy(lang);
    let [eyebrow, title, in_tab, stop] = c.handoff;
    ComposerDecisionPanel::new("dp-handoff", Icon::Lock, title, |_, _, _| {})
        .eyebrow(eyebrow)
        .details([
            Detail::line(format!("{} · {}", c.handoff_title, c.mfa)),
            Detail::line(in_tab),
        ])
        .media(
            Media::new(
                BrowserPage { ring: false },
                format!("{} · {}", c.open_to_check, c.handoff_tab),
            )
            .on_open(|_, _, _| {}),
        )
        .action(Action::new(stop, Variant::Secondary, |_, _| {}).icon(Icon::Square))
        .action(Action::new(c.open_to_check, Variant::Default, |_, _| {}))
}

/// The mock page as an element that reads its colours at render time.
#[derive(IntoElement)]
struct BrowserPage {
    ring: bool,
}

impl gpui::RenderOnce for BrowserPage {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        page_mock(self.ring, cx)
    }
}

/// The keyboard story: 1 and 2 focus a decision, Enter runs it; the panel leaves first.
fn keyboard(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let result = window.use_keyed_state("dp-keyboard-result", cx, |_, _| String::new());
    let text = result.read(cx).clone();
    if !text.is_empty() {
        return Typo::caption(text).into_any_element();
    }
    let (denied, allowed) = (result.clone(), result);
    let panel =
        ComposerDecisionPanel::new("dp-keyboard", Icon::ShieldCheck, c.authority, |_, _, _| {})
            .eyebrow(c.eyebrow_permission)
            .details([Detail::line("Exact target: workspace/output.txt")])
            .action(
                Action::new(c.deny, Variant::Secondary, move |_, cx| {
                    denied.update(cx, |text, cx| {
                        *text = "Denied".into();
                        cx.notify();
                    });
                })
                .deferred(),
            )
            .action(
                Action::new(c.once, Variant::Default, move |_, cx| {
                    allowed.update(cx, |text, cx| {
                        *text = "Allowed".into();
                        cx.notify();
                    });
                })
                .deferred(),
            );
    ComposerCard::new("dp-keyboard-card")
        .child(panel)
        .into_any_element()
}
