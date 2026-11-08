//! The Linux status icon: a StatusNotifierItem served over D-Bus on its own thread. With no
//! StatusNotifierWatcher on the bus the desktop shows no status area, and `create` says
//! `Unsupported` so the window close rule falls back to quit.
use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::{CheckmarkItem, MenuItem, StandardItem, SubMenu};
use ksni::{Icon, ToolTip};
use tokio::sync::mpsc::UnboundedSender;

use super::pixmap;
use super::{TrayError, TrayEvent, TrayIcon as Mark, TrayItem};

/// The sizes offered to the host, which picks the nearest (1x and 2x of the usual 22 px).
const SIDES: [u32; 2] = [22, 44];

struct Sni {
    tooltip: String,
    pixmaps: Vec<Icon>,
    menu: Vec<TrayItem>,
    events: UnboundedSender<TrayEvent>,
}

pub(super) struct Native {
    handle: Handle<Sni>,
}

/// ARGB32 in network byte order, as the SNI `IconPixmap` wants.
fn pixmaps(mark: Mark<'_>) -> Result<Vec<Icon>, TrayError> {
    let source = pixmap::decode(mark.png)?;
    Ok(SIDES
        .iter()
        .map(|side| {
            let pixels = pixmap::square(&source, *side);
            let data = pixels
                .data
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|&[r, g, b, a]| [a, r, g, b])
                .collect();
            Icon {
                width: i32::try_from(pixels.width).unwrap_or(0),
                height: i32::try_from(pixels.height).unwrap_or(0),
                data,
            }
        })
        .collect())
}

fn entry(item: &TrayItem, events: &UnboundedSender<TrayEvent>) -> MenuItem<Sni> {
    let choose = |id: &String| {
        let (id, events) = (id.clone(), events.clone());
        Box::new(move |_: &mut Sni| {
            let _ = events.send(TrayEvent::Item(id.clone()));
        })
    };
    match item {
        TrayItem::Action { id, label, enabled } => StandardItem {
            label: label.clone(),
            enabled: *enabled,
            activate: choose(id),
            ..Default::default()
        }
        .into(),
        TrayItem::Check { id, label, checked } => CheckmarkItem {
            label: label.clone(),
            checked: *checked,
            activate: choose(id),
            ..Default::default()
        }
        .into(),
        TrayItem::Label(text) => StandardItem {
            label: text.clone(),
            enabled: false,
            ..Default::default()
        }
        .into(),
        TrayItem::Separator => MenuItem::Separator,
        TrayItem::Submenu { label, items } => SubMenu {
            label: label.clone(),
            submenu: items.iter().map(|child| entry(child, events)).collect(),
            ..Default::default()
        }
        .into(),
    }
}

impl ksni::Tray for Sni {
    fn id(&self) -> String {
        "butler".into()
    }

    fn title(&self) -> String {
        self.tooltip.clone()
    }

    fn tool_tip(&self) -> ToolTip {
        ToolTip {
            title: self.tooltip.clone(),
            ..Default::default()
        }
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        self.pixmaps.clone()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        let _ = self.events.send(TrayEvent::Open);
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        self.menu
            .iter()
            .map(|item| entry(item, &self.events))
            .collect()
    }
}

impl Native {
    pub(super) fn create(
        mark: Mark<'_>,
        tooltip: &str,
        menu: &[TrayItem],
        events: UnboundedSender<TrayEvent>,
    ) -> Result<Self, TrayError> {
        let tray = Sni {
            tooltip: tooltip.to_owned(),
            pixmaps: pixmaps(mark)?,
            menu: menu.to_vec(),
            events,
        };
        let handle = tray.spawn().map_err(|_| TrayError::Unsupported)?;
        Ok(Self { handle })
    }

    pub(super) fn set_menu(&self, menu: &[TrayItem]) {
        let menu = menu.to_vec();
        let _ = self.handle.update(move |tray| tray.menu = menu);
    }

    pub(super) fn set_icon(&self, mark: Mark<'_>) {
        if let Ok(pixmaps) = pixmaps(mark) {
            let _ = self.handle.update(move |tray| tray.pixmaps = pixmaps);
        }
    }
}

impl Drop for Native {
    fn drop(&mut self) {
        let _ = self.handle.shutdown();
    }
}
