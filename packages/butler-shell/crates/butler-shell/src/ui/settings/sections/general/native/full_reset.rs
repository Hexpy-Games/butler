//! The full reset section (`FullResetSection`, `useFullReset`): a typed confirmation, then
//! `lifecycle::reset::full_reset` (admin nonce, stop the Agent, relaunch).
use std::sync::atomic::{AtomicBool, Ordering};

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, ParentElement as _, SharedString};

use super::super::copy::GeneralCopy;
use crate::lifecycle::reset::full_reset;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::confirm::{Detail, Request, Typed};

/// settings.fullReset.{title, body, removed, kept, phrase, confirm, mismatch} and
/// settings.memory.{removed, kept}.
struct Words {
    title: &'static str,
    body: &'static str,
    removed_label: &'static str,
    removed: &'static str,
    kept_label: &'static str,
    kept: &'static str,
    phrase: &'static str,
    confirm: &'static str,
    mismatch: &'static str,
}

static KO: Words = Words {
    title: "버틀러를 처음 상태로 되돌릴까요?",
    body: "모든 채팅, 기억, 예약 작업, 설정, 저장된 키가 지워지고 앱이 다시 시작됩니다. 되돌릴 수 없습니다.",
    removed_label: "지워짐",
    removed: "채팅, 지침, 기억, 프로필, 예약 작업, 설정, 저장된 키와 로그인, 브라우저 데이터, 로그",
    kept_label: "유지됨",
    kept: "프로젝트 폴더, 내려받은 모델, 버틀러가 만들지 않은 파일",
    phrase: "동의합니다",
    confirm: "초기화하고 다시 시작",
    mismatch: "문구를 정확히 입력하세요",
};

static EN: Words = Words {
    title: "Reset Butler completely?",
    body: "All chats, memory, schedules, settings and saved keys will be erased, and the app will restart. This can't be undone.",
    removed_label: "Will be removed",
    removed: "Chats, instructions, memory, profile, schedules, settings, saved keys and sign-ins, browser data and logs",
    kept_label: "Will be kept",
    kept: "Project folders, downloaded models and files Butler didn't create",
    phrase: "I agree",
    confirm: "Reset and restart",
    mismatch: "Type the phrase exactly",
};

fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// settings.fullReset.field(phrase)
fn field_label(lang: Lang, phrase: &str) -> SharedString {
    match lang {
        Lang::Ko => format!("확인하려면 ‘{phrase}’를 입력하세요"),
        Lang::En => format!("Type “{phrase}” to confirm"),
    }
    .into()
}

/// `useFullReset`'s `running`: set from the accepted confirmation until a failure; on success the
/// app relaunches.
static RUNNING: AtomicBool = AtomicBool::new(false);

fn rerender(ctx: &SectionCtx, cx: &mut App) {
    ctx.state.update(cx, |_, cx| cx.notify());
}

/// `confirmAction` with the typed phrase, as `useFullReset.start`.
fn start(ctx: &SectionCtx, cx: &mut App) {
    if RUNNING.load(Ordering::Acquire) {
        return;
    }
    let lang = Ds::get(cx).lang();
    let copy = words(lang);
    let request = Request::new(copy.body)
        .title(copy.title)
        .confirm_label(copy.confirm)
        .destructive()
        .detail(Detail {
            label: Some(copy.removed_label.into()),
            text: copy.removed.into(),
            caption: None,
        })
        .detail(Detail {
            label: Some(copy.kept_label.into()),
            text: copy.kept.into(),
            caption: None,
        })
        .typed(Typed {
            phrase: copy.phrase.into(),
            label: field_label(lang, copy.phrase),
            mismatch: copy.mismatch.into(),
        });
    let owner = ctx.clone();
    ctx.confirm(request, move |_, cx| run(&owner, cx), cx);
}

/// The accepted reset: busy until the app relaunches; a failure shows the error toast.
fn run(ctx: &SectionCtx, cx: &mut App) {
    RUNNING.store(true, Ordering::Release);
    rerender(ctx, cx);
    let task = full_reset(cx);
    let ctx = ctx.clone();
    cx.spawn(async move |cx| {
        if let Err(message) = task.await {
            RUNNING.store(false, Ordering::Release);
            cx.update(|cx| {
                toast::show(cx, Toast::error(message));
                rerender(&ctx, cx);
            });
        }
    })
    .detach();
}

pub(in super::super) fn section(ctx: &SectionCtx, copy: &'static GeneralCopy) -> SettingsSection {
    let [label, description, action] = copy.full_reset;
    let running = RUNNING.load(Ordering::Acquire);
    let ctx = ctx.clone();
    let mut button = Button::new("full-reset")
        .variant(Variant::Destructive)
        .text(if running { copy.resetting } else { action })
        .on_click(move |_, _, cx| start(&ctx, cx));
    if running {
        button = button
            .icon_start(Spinner::new("full-reset-spinner").size(14.))
            .aria_disabled();
    }
    SettingsSection::new("full-reset", SettingsSectionKind::Form, copy.sections[9]).child(
        SettingsField::new(label)
            .description(description)
            .setting_id("full-reset")
            .control(button),
    )
}
