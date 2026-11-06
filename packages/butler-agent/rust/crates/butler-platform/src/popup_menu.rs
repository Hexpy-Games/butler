//! The operating system's popup menu: the picker a native `<select>` opens.
//!
//! Electron's `<select>` shows the OS menu, and the native shell's `NativeSelect` has to do the
//! same. gpui-ce at the pinned revision has no popup-menu API (only `set_menus` and
//! `set_dock_menu`), so this is a stub that shows nothing and picks nothing.
//!
//! Follow-up: macOS needs an `NSMenu` shown with `popUpMenuPositioningItem:atLocation:inView:`
//! and Windows a `TrackPopupMenuEx` call. Both are unsafe FFI, which belongs behind the audited
//! unsafe boundary of D-P2, or behind a gpui-ce popup-menu API if one lands first. Neither may
//! be drawn by the caller as a fake menu.

/// One row of the menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupItem<'a> {
    /// A choice the user can pick.
    Option(&'a str),
    /// A group heading (`<optgroup label>`): shown, never picked.
    Group(&'a str),
}

/// The control the menu opens from, in screen points: the menu's top-left is placed over it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PopupAnchor {
    /// Left edge of the control.
    pub x: f32,
    /// Top edge of the control.
    pub y: f32,
    /// Width of the control, the minimum width of the menu.
    pub width: f32,
    /// Height of the control.
    pub height: f32,
}

/// Shows `items` as the OS popup menu over `anchor`, with the `selected` item (an index into
/// `items`) checked and under the pointer, and returns the index of the item the user picked,
/// or `None` when the menu was dismissed.
///
/// Stub: no OS menu is wired up yet, so this always returns `None` (see the module docs for the
/// `NSMenu` and `TrackPopupMenuEx` follow-up).
pub fn popup_menu(
    items: &[PopupItem<'_>],
    selected: Option<usize>,
    anchor: PopupAnchor,
) -> Option<usize> {
    let _ = (items, selected, anchor);
    None
}
