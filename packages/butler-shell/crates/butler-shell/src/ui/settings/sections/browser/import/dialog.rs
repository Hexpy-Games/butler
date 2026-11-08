//! The import dialog (`BrowserImportDialog.tsx`): choose a browser, choose what to bring, import.
//! Each open starts a fresh flow, so the dialog is its own entity and dies with the dialog.
use std::rc::Rc;

use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::setup_wizard_shell::{SetupWizardProgress, SetupWizardStep};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, IntoElement, ParentElement as _, Render, Window,
};

use super::copy::{Words, words};
use super::model::{Counts, FILE, Kind, Phase, Source, kinds};
use crate::ui::settings::Action;

/// What runs once an import brought data in.
pub(super) type Imported = Rc<dyn Fn(&mut App)>;

/// What the import brings over.
#[derive(Clone, Copy)]
pub(super) struct Kinds {
    pub(super) bookmarks: bool,
    pub(super) history: bool,
    pub(super) passwords: bool,
}

pub(super) struct ImportDialog {
    /// `SettingsSignIns` reports the system password store.
    pub(super) keychain: bool,
    pub(super) on_close: Action,
    /// `onImported`: the sign-ins list reloads after an import.
    pub(super) on_imported: Imported,
    pub(super) step: usize,
    pub(super) picked: Option<String>,
    pub(super) disk_hint: bool,
    pub(super) sources: Option<Vec<Source>>,
    pub(super) selected: String,
    pub(super) kinds: Kinds,
    pub(super) busy: bool,
    pub(super) error: Option<String>,
    pub(super) result: Option<Counts>,
    pub(super) export_id: Option<String>,
}

/// A button handler that updates the dialog.
pub(super) fn act(
    me: &Entity<ImportDialog>,
    work: impl Fn(&mut ImportDialog, &mut Context<ImportDialog>) + 'static,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let me = me.clone();
    move |_, _, cx| me.update(cx, |this, cx| work(this, cx))
}

/// A footer button: outline unless primary.
fn footer_button(
    id: &'static str,
    label: &'static str,
    primary: bool,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Button {
    let button = Button::new(id).text(label).on_click(on_click);
    let button = if primary {
        button
    } else {
        button.variant(Variant::Outline)
    };
    if disabled { button.disabled() } else { button }
}

impl ImportDialog {
    pub(super) fn new(
        keychain: bool,
        on_close: Action,
        on_imported: Imported,
        cx: &mut Context<Self>,
    ) -> Self {
        let this = Self {
            keychain,
            on_close,
            on_imported,
            step: 0,
            picked: None,
            disk_hint: false,
            sources: None,
            selected: FILE.into(),
            kinds: Kinds {
                bookmarks: true,
                history: true,
                passwords: true,
            },
            busy: false,
            error: None,
            result: None,
            export_id: None,
        };
        Self::load_sources(cx);
        cx.on_release(ImportDialog::release).detach();
        this
    }

    /// `importPhase`
    pub(super) fn phase(&self) -> Phase {
        if self.busy && self.result.is_none() {
            return Phase::Progress;
        }
        if self.export_id.is_some() {
            return Phase::Csv;
        }
        match self.error.as_deref() {
            Some("full_disk_access_required") => Phase::Permission,
            Some("primary_password_required" | "incorrect_primary_password") => Phase::Primary,
            Some(_) => Phase::Error,
            None if self.result.is_some() => Phase::Done,
            None if self.busy => Phase::Progress,
            None => Phase::Idle,
        }
    }

    /// `picked ?? sources[0].key`
    fn choice(&self) -> Option<String> {
        self.picked.clone().or_else(|| {
            self.sources
                .as_ref()?
                .first()
                .map(|source| source.key.clone())
        })
    }

    pub(super) fn is_on(&self, kind: Kind) -> bool {
        match kind {
            Kind::Bookmarks => self.kinds.bookmarks,
            Kind::Passwords => self.kinds.passwords,
            Kind::History => self.kinds.history,
        }
    }

    pub(super) fn set_on(&mut self, kind: Kind, on: bool) {
        match kind {
            Kind::Bookmarks => self.kinds.bookmarks = on,
            Kind::Passwords => self.kinds.passwords = on,
            Kind::History => self.kinds.history = on,
        }
    }

    /// `needsKeychain`: passwords need the system password store.
    fn needs_keychain(&self) -> bool {
        self.kinds.passwords && !self.keychain
    }

    fn blocked(&self, source: &str) -> bool {
        self.busy
            || self.export_id.is_some()
            || !kinds(source).iter().any(|kind| self.is_on(*kind))
            || self.needs_keychain()
    }

    /// Step 2's Import button: `run`.
    fn import_chosen(&mut self, cx: &mut Context<Self>) {
        let source = self.choice().unwrap_or_else(|| self.selected.clone());
        if self.blocked(&source) {
            return;
        }
        self.step = 2;
        self.disk_hint = false;
        self.run(source, cx);
    }

    fn footer(&self, view: usize, phase: Phase, me: &Entity<Self>, cx: &App) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let close = self.on_close.clone();
        let close = move |_: &ClickEvent, window: &mut Window, cx: &mut App| close(window, cx);
        let buttons: Vec<AnyElement> = match view {
            0 => vec![
                footer_button("browser-import-cancel", copy.cancel, false, false, close)
                    .into_any_element(),
                footer_button(
                    "browser-import-next",
                    copy.next,
                    true,
                    self.choice().is_none(),
                    act(me, |this, cx| {
                        this.step = 1;
                        cx.notify();
                    }),
                )
                .into_any_element(),
            ],
            1 => {
                let source = self.choice().unwrap_or_else(|| self.selected.clone());
                let run = footer_button(
                    "browser-import-run",
                    copy.run,
                    true,
                    self.blocked(&source),
                    act(me, ImportDialog::import_chosen),
                );
                let run = if self.needs_keychain() && !self.busy {
                    Tooltip::new("browser-import-run-reason")
                        .label(copy.needs_keychain)
                        .child(run)
                        .into_any_element()
                } else {
                    run.into_any_element()
                };
                vec![
                    footer_button(
                        "browser-import-back",
                        copy.back,
                        false,
                        self.busy,
                        act(me, |this, cx| {
                            this.step = 0;
                            cx.notify();
                        }),
                    )
                    .into_any_element(),
                    run,
                ]
            }
            _ => self.outcome_actions(copy, phase, me, close),
        };
        button::container(Size::Default)
            .justify(Justify::End)
            .children(buttons)
            .into_any_element()
    }

    /// `outcomeActions`: step 3's footer, right-aligned with the primary action last.
    fn outcome_actions(
        &self,
        copy: &'static Words,
        phase: Phase,
        me: &Entity<Self>,
        close: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Vec<AnyElement> {
        let busy = self.busy;
        let back = || {
            footer_button(
                "browser-import-back",
                copy.back,
                false,
                busy,
                act(me, |this, cx| {
                    this.step = 1;
                    cx.notify();
                }),
            )
        };
        let buttons: Vec<Button> = match phase {
            Phase::Idle => Vec::new(),
            Phase::Progress => vec![footer_button(
                "browser-import-done",
                copy.done,
                true,
                true,
                |_, _, _| {},
            )],
            Phase::Csv => csv_buttons(copy, busy, me),
            Phase::Permission => permission_buttons(copy, busy, me),
            // CARVE-OUT(G-secret-input): React's Run submits the typed primary password; the DS
            // has no masked input, so the owner can only go back.
            Phase::Primary => vec![back()],
            Phase::Error => vec![
                back(),
                footer_button(
                    "browser-import-retry",
                    copy.retry,
                    true,
                    busy,
                    act(me, |this, cx| {
                        let source = this.selected.clone();
                        this.run(source, cx);
                    }),
                ),
            ],
            Phase::Done => self.done_buttons(copy, me, close),
        };
        buttons
            .into_iter()
            .map(IntoElement::into_any_element)
            .collect()
    }

    fn done_buttons(
        &self,
        copy: &'static Words,
        me: &Entity<Self>,
        close: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Vec<Button> {
        let busy = self.busy;
        let result = self.result.as_ref();
        let mut buttons = Vec::new();
        if result.is_some_and(|result| result.needs_csv == Some(true) && result.export_id.is_none())
        {
            buttons.push(footer_button(
                "browser-import-export",
                copy.export_passwords,
                false,
                busy,
                act(me, ImportDialog::resume_export),
            ));
        }
        if result.is_some_and(|result| result.export_id.is_some()) {
            buttons.push(footer_button(
                "browser-import-delete-csv",
                copy.delete_csv,
                false,
                busy,
                act(me, ImportDialog::remove_csv),
            ));
        }
        buttons.push(footer_button(
            "browser-import-more",
            copy.more,
            false,
            busy,
            act(me, ImportDialog::more),
        ));
        buttons.push(footer_button(
            "browser-import-finish",
            copy.done,
            true,
            busy,
            close,
        ));
        buttons
    }
}

impl Render for ImportDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let phase = self.phase();
        let view = if self.step == 2 && phase == Phase::Idle {
            1
        } else {
            self.step
        };
        let choice = self.choice();
        let source = choice.clone().unwrap_or_else(|| self.selected.clone());
        let body: AnyElement = match view {
            0 => match self.sources {
                Some(_) => self.choices(choice.as_deref(), &me, cx),
                None => Stack::row()
                    .justify(Justify::Center)
                    .child(Spinner::new("browser-import-sources"))
                    .into_any_element(),
            },
            1 => Stack::new()
                .gap(Space::Md)
                .child(self.chosen(&source, None, cx))
                .child(self.items(&source, &me, cx))
                .into_any_element(),
            _ => self.outcome(phase, cx),
        };
        let steps = [
            ("browser", copy.choose_browser),
            ("items", copy.choose_items),
            ("import", copy.run),
        ]
        .map(|(id, label)| SetupWizardStep::new(id, label));
        let form = DialogForm::new(copy.open)
            .footer(self.footer(view, phase, &me, cx))
            .child(SetupWizardProgress::new(steps, view))
            .child(Stack::new().gap(Space::Md).child(body));
        let close = self.on_close.clone();
        let dialog = Dialog::new("browser-import-dialog", window, cx)
            .open(true)
            .on_open_change(move |open, window, cx| {
                if !open {
                    close(window, cx);
                }
            });
        dialog.content(DialogContent::new().child(form), window, cx)
    }
}

/// The CSV step's footer: cancel the export, or pick the exported file by hand.
fn csv_buttons(copy: &'static Words, busy: bool, me: &Entity<ImportDialog>) -> Vec<Button> {
    vec![
        footer_button(
            "browser-import-cancel-csv",
            copy.cancel,
            false,
            busy,
            act(me, ImportDialog::cancel),
        ),
        footer_button(
            "browser-import-choose-file",
            copy.choose_file,
            true,
            busy,
            act(me, ImportDialog::select_csv),
        ),
    ]
}

/// The disk-access step's footer: open the system setting, or pick the profile folder.
fn permission_buttons(copy: &'static Words, busy: bool, me: &Entity<ImportDialog>) -> Vec<Button> {
    vec![
        footer_button(
            "browser-import-disk-access",
            copy.disk_access,
            false,
            busy,
            act(me, ImportDialog::open_disk_access),
        ),
        footer_button(
            "browser-import-pick-folder",
            copy.pick_folder,
            true,
            busy,
            act(me, ImportDialog::folder),
        ),
    ]
}
