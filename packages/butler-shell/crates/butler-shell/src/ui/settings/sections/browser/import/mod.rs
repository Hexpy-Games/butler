//! Import from another browser (`SecurityBrowserImportSection.tsx`, `BrowserImportDialog.tsx`,
//! `BrowserImportOutcome.tsx`, `BrowserImportSources.tsx`, `useBrowserImport.ts`): one button
//! that opens the import dialog. Passwords stay out of view state.
mod copy;
mod dialog;
mod flow;
mod model;
mod steps;

use std::rc::Rc;

use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use gpui::{App, AppContext as _, Context, Entity, ParentElement as _, Window};

use super::vault::BrowserVault;
use crate::ui::settings::Action;
use copy::words;
use dialog::{ImportDialog, Imported};

/// `SecurityBrowserImportSection`: `keychain` and `onImported` come from the sign-ins
/// (`SecuritySignInsSections`).
pub(super) struct BrowserImport {
    vault: Entity<BrowserVault>,
    dialog: Option<Entity<ImportDialog>>,
}

impl BrowserImport {
    pub(super) fn new(vault: Entity<BrowserVault>) -> Self {
        Self {
            vault,
            dialog: None,
        }
    }

    pub(super) fn section(&mut self, _: &mut Window, cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let keychain = self.vault.read(cx).keychain_available();
        if let Some(dialog) = &self.dialog {
            dialog.update(cx, |dialog, _| dialog.keychain = keychain);
        }
        let me = cx.entity();
        let open = Button::new("browser-import-open")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.open)
            .on_click(move |_, _, cx| {
                me.update(cx, BrowserImport::open);
            });
        let field = SettingsActionField::new(copy.data_label, copy.purpose, open)
            .setting_id("browser-import-data");
        SettingsSection::new("browser-import", SettingsSectionKind::Form, copy.title)
            .child(field)
            .children(self.dialog.clone())
    }

    /// Each open starts a fresh flow.
    fn open(&mut self, cx: &mut Context<Self>) {
        let weak = cx.weak_entity();
        let on_close: Action = Rc::new(move |_: &mut Window, cx: &mut App| {
            let _ = weak.update(cx, |this, cx| {
                this.dialog = None;
                cx.notify();
            });
        });
        let vault = self.vault.downgrade();
        let on_imported: Imported = Rc::new(move |cx: &mut App| {
            let _ = vault.update(cx, |_, cx| BrowserVault::reload_sign_ins(cx));
        });
        let keychain = self.vault.read(cx).keychain_available();
        self.dialog = Some(cx.new(|cx| ImportDialog::new(keychain, on_close, on_imported, cx)));
        cx.notify();
    }
}
