//! The 서랍 detail, dialogs, file viewer and drags (`library/LibraryDetail.tsx`,
//! `LibraryDialogHost.tsx`, `libraryDialogs.ts`, `libraryActions.ts`, `libraryDrop.ts`,
//! `libraryCardDrag.ts`, `libraryGroupDrag.ts`, `LibraryFileViewer.tsx`,
//! `browser/LibraryAttachDialog.tsx`).
//!
//! React keeps the dialog state, the dwell's `before` view and the detail's item in module-level
//! stores; the free functions below reach them through [`runtime`] and `LibraryNames`.
// Free functions of the seam are called by the page, the sidebar and the chat, not here.
#![allow(
    dead_code,
    reason = "seam API: the page, the sidebar and the shell call it; F6 removes this"
)]
mod actions;
pub(crate) mod api;
mod attach;
mod copy;
mod delete;
mod dialogs;
mod drag;
mod files;
mod group;
mod item_tags;
mod panel;
mod runtime;
mod saved;
mod tags;

pub(crate) use actions::{item_meta, rename_item};
pub(crate) use attach::attach_dialog;
pub(crate) use dialogs::{LibraryDialog, LibraryDialogsEvent};
pub(crate) use drag::{
    CardDrag, GroupDrag, card_ghost, drop_cards_on_group, drop_cards_on_session, drop_group_on,
    group_ghost,
};
pub(crate) use files::{file_viewer, open_detail, open_file, open_page};
pub(crate) use panel::LibraryDetail;
pub(crate) use runtime::{dialog_host, install, open_dialog};
