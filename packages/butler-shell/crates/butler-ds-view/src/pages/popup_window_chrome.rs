//! PopupWindowChrome.showcase.tsx: a 400x540 pop-up window on macOS (the OS draws the lights, drawn
//! here for the preview), on Windows (the app's window controls at the end) and not secure.
use butler_ds::tokens::{Color, Length, Shadow};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::ShellPlatform;
use butler_ds::ui::blocks::popup_window_chrome::PopupWindowChrome;
use butler_ds::ui::button::{self, Button, Size};
use butler_ds::ui::context::Ds;
use butler_ds::ui::convert::box_shadows;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box as DsBox, Justify, Space, Stack};
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, div, px};

use super::Story;
use crate::browser_demo::sub;
use crate::copy::Lang;

struct Words {
    secure: &'static str,
    insecure: &'static str,
    sign_in: &'static str,
    email: &'static str,
    next: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    close: &'static str,
}

fn words(lang: Lang) -> Words {
    lang.pick(
        Words {
            secure: "Secure connection",
            insecure: "Not secure",
            sign_in: "Sign in to continue",
            email: "Email",
            next: "Next",
            minimize: "Minimize window",
            maximize: "Maximize window",
            close: "Close window",
        },
        Words {
            secure: "안전한 연결",
            insecure: "주의 요함",
            sign_in: "계속하려면 로그인하십시오",
            email: "이메일",
            next: "다음",
            minimize: "창 최소화",
            maximize: "창 최대화",
            close: "창 닫기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "macOS pop-up window",
            render: |l, _, c| window("pw-mac", ShellPlatform::Darwin, true, l, c),
        },
        Story {
            name: "Windows pop-up window",
            render: |l, _, c| window("pw-win", ShellPlatform::Win32, true, l, c),
        },
        Story {
            name: "Not secure",
            render: |l, _, c| window("pw-insecure", ShellPlatform::Darwin, false, l, c),
        },
    ]
}

/// `SignInPage`: the pop-up's page, standing in for the page surface.
fn sign_in(id: &'static str, w: &Words) -> AnyElement {
    DsBox::new()
        .padding(Space::Xl)
        .child(
            Stack::new()
                .gap(Space::Lg)
                .child(Typo::panel_title(w.sign_in))
                .child(
                    Field::new(sub(id, "email"))
                        .child(FieldLabel::new().child(w.email))
                        .child(Input::new(sub(id, "input")).default_value("name@example.com")),
                )
                .child(
                    Stack::row().justify(Justify::End).child(
                        button::container(Size::Sm)
                            .child(Button::new(sub(id, "next")).size(Size::Sm).text(w.next)),
                    ),
                ),
        )
        .into_any_element()
}

/// The three native lights at x 12, y 13: 14px buttons, 60px apart end to end
/// (`fixtures.module.css` `.lights`).
fn lights(ds: &Ds) -> AnyElement {
    let dot = |color: Color| {
        div()
            .size(px(14.)) // DS: fixtures.module.css:49
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(color))
    };
    div()
        .absolute()
        .top(px(13.)) // DS: fixtures.module.css:41
        .left(px(12.)) // DS: fixtures.module.css:42
        .flex()
        .w(px(60.)) // DS: fixtures.module.css:44
        .justify_between()
        .child(dot(Color::Red05))
        .child(dot(Color::Amber05))
        .child(dot(Color::Green05))
        .into_any_element()
}

/// `PopupWindow`: a 400x540 window as the OS draws it.
fn window(
    id: &'static str,
    platform: ShellPlatform,
    secure: bool,
    lang: Lang,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let w = words(lang);
    let label = if secure { w.secure } else { w.insecure };
    let mut chrome = PopupWindowChrome::new(sub(id, "chrome"), "id.example.com", label)
        .secure(secure)
        .platform(platform)
        .child(sign_in(id, &w));
    if platform == ShellPlatform::Win32 {
        chrome = chrome.window_controls(
            button::container(Size::IconSm)
                .child(IconButton::new(sub(id, "min"), w.minimize).glyph(Icon::Minus))
                .child(IconButton::new(sub(id, "max"), w.maximize).glyph(Icon::Square))
                .child(IconButton::new(sub(id, "close"), w.close).glyph(Icon::X)),
        );
    }
    div()
        .relative()
        .overflow_hidden()
        .w_full()
        .max_w(px(400.))
        .h(px(540.))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::LineStrong))
        .rounded(ds.len(Length::RadiusPopover))
        .shadow(box_shadows(
            ds.tokens().shadow(Shadow::ShadowWindow),
            ds.tokens(),
        ))
        .child(chrome)
        // `z-index: 1`: the lights sit over the bar.
        .children((platform == ShellPlatform::Darwin).then(|| lights(ds)))
        .into_any_element()
}
