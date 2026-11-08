//! The macOS menu-bar item and the Windows notification-area icon, through `tray-icon` (menus
//! by `muda`). Both are created on the main thread, whose message loop delivers their events.
use ::tray_icon::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use ::tray_icon::{Icon, MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tokio::sync::mpsc::UnboundedSender;

use super::pixmap;
use super::{TrayError, TrayEvent, TrayIcon as Mark, TrayItem};

/// The mark's side in pixels: 18 pt at 2x on macOS, 20 px on Windows (Electron's sizes).
const SIDE: u32 = if cfg!(target_os = "macos") { 36 } else { 20 };

pub(super) struct Native {
    icon: TrayIcon,
}

fn failed(call: &str, error: impl std::fmt::Display) -> TrayError {
    TrayError::Failed(format!("{call}: {error}"))
}

fn image(mark: Mark<'_>) -> Result<Icon, TrayError> {
    let pixels = pixmap::square(&pixmap::decode(mark.png)?, SIDE);
    Icon::from_rgba(pixels.data, pixels.width, pixels.height)
        .map_err(|e| failed("tray icon image", e))
}

fn entry(item: &TrayItem) -> Result<Box<dyn IsMenuItem>, TrayError> {
    Ok(match item {
        TrayItem::Action { id, label, enabled } => {
            Box::new(MenuItem::with_id(id.as_str(), label, *enabled, None))
        }
        TrayItem::Check { id, label, checked } => Box::new(CheckMenuItem::with_id(
            id.as_str(),
            label,
            true,
            *checked,
            None,
        )),
        TrayItem::Label(text) => Box::new(MenuItem::new(text, false, None)),
        TrayItem::Separator => Box::new(PredefinedMenuItem::separator()),
        TrayItem::Submenu { label, items } => {
            let submenu = Submenu::new(label, true);
            for child in items {
                submenu
                    .append(&*entry(child)?)
                    .map_err(|e| failed("tray submenu", e))?;
            }
            Box::new(submenu)
        }
    })
}

fn build(items: &[TrayItem]) -> Result<Menu, TrayError> {
    let menu = Menu::new();
    for item in items {
        menu.append(&*entry(item)?)
            .map_err(|e| failed("tray menu", e))?;
    }
    Ok(menu)
}

impl Native {
    pub(super) fn create(
        mark: Mark<'_>,
        tooltip: &str,
        menu: &[TrayItem],
        events: UnboundedSender<TrayEvent>,
    ) -> Result<Self, TrayError> {
        let menu = build(menu)?;
        let image = image(mark)?;
        let items = events.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let _ = items.send(TrayEvent::Item(event.id.0));
        }));
        TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                let _ = events.send(TrayEvent::Open);
            }
        }));
        let builder = TrayIconBuilder::new()
            .with_icon(image)
            .with_tooltip(tooltip)
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(true);
        // A template image: macOS tints it for the menu bar, whatever the wallpaper.
        #[cfg(target_os = "macos")]
        let builder = builder.with_icon_as_template(true);
        let icon = builder.build().map_err(|e| failed("create tray icon", e))?;
        Ok(Self { icon })
    }

    pub(super) fn set_menu(&self, menu: &[TrayItem]) {
        if let Ok(menu) = build(menu) {
            self.icon.set_menu(Some(Box::new(menu)));
        }
    }

    pub(super) fn set_icon(&self, mark: Mark<'_>) {
        if let Ok(image) = image(mark) {
            let _ = self.icon.set_icon(Some(image));
        }
    }
}
