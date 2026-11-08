//! The dialog's step bodies (`BrowserImportSources.tsx`, `BrowserImportOutcome.tsx`).
use butler_ds::ui::blocks::check_card::{CheckCard, CheckCardList};
use butler_ds::ui::blocks::choice_card::{ChoiceCard, ChoiceCardList, glyph};
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{FieldLegend, FieldSet};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Entity, IntoElement, ParentElement as _, SharedString};

use super::copy::{Words, result_line, words};
use super::dialog::ImportDialog;
use super::model::{FILE, Kind, Phase, kinds};
use crate::ui::Icon;

/// Brand name of a detected browser; unknown browsers keep their own id.
fn brand(browser: &str) -> String {
    match browser {
        "chrome" => "Chrome",
        "chromium" => "Chromium",
        "edge" => "Edge",
        "brave" => "Brave",
        "arc" => "Arc",
        "whale" => "Whale",
        "firefox" => "Firefox",
        "zen" => "Zen",
        "safari" => "Safari",
        other => other,
    }
    .to_string()
}

/// A source's icon, brand and profile name (none when the profile is the brand, as Safari's is).
struct Described {
    icon: AnyElement,
    brand: String,
    profile: Option<String>,
    denied: bool,
}

fn kind_icon(kind: Kind) -> Icon {
    match kind {
        Kind::Bookmarks => Icon::Bookmark,
        Kind::Passwords => Icon::Key,
        Kind::History => Icon::History,
    }
}

fn kind_label(copy: &Words, kind: Kind) -> &'static str {
    match kind {
        Kind::Bookmarks => copy.bookmarks,
        Kind::Passwords => copy.passwords,
        Kind::History => copy.history,
    }
}

fn kind_id(kind: Kind) -> &'static str {
    match kind {
        Kind::Bookmarks => "browser-import-item-bookmarks",
        Kind::Passwords => "browser-import-item-passwords",
        Kind::History => "browser-import-item-history",
    }
}

fn spinner_row(id: &'static str, text: &'static str) -> AnyElement {
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(Spinner::new(id))
        .child(Typo::body(text))
        .into_any_element()
}

impl ImportDialog {
    fn describe(&self, key: &str, copy: &Words, cx: &App) -> Described {
        match self
            .sources
            .iter()
            .flatten()
            .find(|source| source.key == key)
        {
            None => Described {
                icon: glyph(Icon::FileText, cx).into_any_element(),
                brand: copy.from_file.to_string(),
                profile: Some(format!("{} · {}", copy.html_file, copy.csv_file)),
                denied: false,
            },
            Some(source) => {
                let brand = brand(&source.browser);
                Described {
                    // CARVE-OUT(G-brand-icons): React shows the browser's own logo
                    // (`/browser-icons/<browser>.svg`); the DS has no such assets yet.
                    icon: glyph(Icon::Globe2, cx).into_any_element(),
                    profile: (source.name != brand).then(|| source.name.clone()),
                    brand,
                    denied: source.permission.as_deref() == Some("denied"),
                }
            }
        }
    }

    /// Step 1: detected profiles as radio cards, an honest empty line, then file import as the
    /// last choice.
    pub(super) fn choices(&self, choice: Option<&str>, me: &Entity<Self>, cx: &App) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let keys = self
            .sources
            .iter()
            .flatten()
            .map(|source| source.key.clone())
            .chain(std::iter::once(FILE.to_string()));
        let cards = keys.map(|key| {
            let view = self.describe(&key, copy, cx);
            let (pick, picked) = (me.clone(), key.clone());
            let mut card = ChoiceCard::new(
                SharedString::from(format!("browser-import-source-{key}")),
                view.icon,
                view.brand,
            )
            .selected(choice == Some(key.as_str()))
            .chevron(false)
            .on_click(move |_, _, cx| {
                pick.update(cx, |this, cx| {
                    this.picked = Some(picked.clone());
                    cx.notify();
                });
            });
            let description = if view.denied {
                Some(copy.full_disk_access.to_string())
            } else {
                view.profile
            };
            if let Some(description) = description {
                card = card.description(description);
            }
            card
        });
        let empty = self
            .sources
            .iter()
            .flatten()
            .next()
            .is_none()
            .then(|| EmptyLine::new(copy.no_sources));
        Stack::new()
            .gap(Space::Md)
            .children(empty)
            .child(ChoiceCardList::new().children(cards))
            .into_any_element()
    }

    /// The chosen source on top of steps 2 and 3: two lines before the import, one line with the
    /// result after.
    pub(super) fn chosen(&self, source: &str, detail: Option<String>, cx: &App) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let view = self.describe(source, copy, cx);
        let row = match detail {
            None => {
                let row = ListRow::new(view.brand).icon(view.icon);
                match view.profile {
                    Some(profile) => row.description(profile),
                    None => row,
                }
            }
            Some(detail) => {
                let title = match view.profile {
                    Some(profile) if source != FILE => format!("{} · {profile}", view.brand),
                    _ => view.brand,
                };
                ListRow::new(title).icon(view.icon).description(detail)
            }
        };
        row.into_any_element()
    }

    /// Step 2: what this import includes, as multi-select check cards.
    pub(super) fn items(&self, source: &str, me: &Entity<Self>, cx: &App) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let cards = kinds(source).iter().map(|kind| {
            let kind = *kind;
            let set = me.clone();
            let mut card = CheckCard::new(
                kind_id(kind),
                kind_label(copy, kind),
                self.is_on(kind),
                move |on, _, cx| {
                    set.update(cx, |this, cx| {
                        this.set_on(kind, on);
                        cx.notify();
                    });
                },
            )
            .icon(glyph(kind_icon(kind), cx));
            if kind == Kind::Passwords && !self.keychain {
                card = card.description(copy.needs_keychain);
            }
            if self.busy {
                card = card.disabled();
            }
            card
        });
        FieldSet::new()
            .legend(FieldLegend::new().child(copy.choose_items))
            .child(CheckCardList::new().children(cards))
            .into_any_element()
    }

    /// Step 3 body: the chosen source with what it brings (or brought), then the phase's own line.
    pub(super) fn outcome(&self, phase: Phase, cx: &App) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let detail = match &self.result {
            Some(result) => result_line(lang, result.line()),
            None => kinds(&self.selected)
                .iter()
                .filter(|kind| self.is_on(**kind))
                .map(|kind| kind_label(copy, *kind))
                .collect::<Vec<_>>()
                .join(" · "),
        };
        let chosen = self.chosen(&self.selected, Some(detail), cx);
        let line = match phase {
            Phase::Idle | Phase::Done => return chosen,
            Phase::Progress => spinner_row("browser-import-progress", copy.importing),
            Phase::Csv => spinner_row("browser-import-csv", copy.waiting_csv),
            Phase::Permission => self.permission(copy),
            // CARVE-OUT(G-secret-input): React asks for the primary password in a masked input
            // (and shows `wrongPrimaryPassword` after a wrong one); the DS has no masked input.
            Phase::Primary => {
                let wrong = self.error.as_deref() == Some("incorrect_primary_password");
                let message = if wrong {
                    copy.wrong_primary_password
                } else {
                    copy.primary_password
                };
                Notice::new(NoticeTone::Warning, message).into_any_element()
            }
            Phase::Error => {
                let locked = self.error.as_deref() == Some("browser_locked");
                let notice = Notice::new(
                    NoticeTone::Error,
                    if locked {
                        copy.close_browser
                    } else {
                        copy.failed
                    },
                );
                let notice = if locked {
                    notice.title(copy.failed)
                } else {
                    notice
                };
                notice.into_any_element()
            }
        };
        Stack::new()
            .gap(Space::Md)
            .child(chosen)
            .child(line)
            .into_any_element()
    }

    fn permission(&self, copy: &Words) -> AnyElement {
        Stack::new()
            .gap(Space::Sm)
            .child(Notice::new(NoticeTone::Error, copy.full_disk_access).title(copy.failed))
            .children(
                self.disk_hint
                    .then(|| Typo::caption(copy.restart_after_access).tone(Tone::Secondary)),
            )
            .into_any_element()
    }
}
