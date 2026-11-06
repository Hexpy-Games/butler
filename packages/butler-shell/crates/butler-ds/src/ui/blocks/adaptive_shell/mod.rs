//! DS AdaptiveShell (AdaptiveShell.tsx and parts, CSS `AdaptiveShell`/`Cards`/`Frame`): the app
//! shell. The sidebar, the workspace and the inspector dock beside each other, or at drawer
//! widths slide over the workspace under a scrim. The cards frame draws the sidebar, window
//! chrome and title row as one shell surface with the content in rounded cards. Window-level
//! facts (the window size, the chrome environment, the platform) are inputs.
pub mod frame;
mod frame_cfg;
pub mod grip;
mod layout;
pub mod parts;
pub mod peek;
pub mod split;
mod track;

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, IntoElement, RenderOnce, Window};

pub use super::scope::ShellFrame;
pub use frame_cfg::{HandleSide, ShellPlatform, ShellWindow, SplitConfig};
use parts::Callback;
use peek::SidebarPeek;

use super::responsive::ChromeEnvironment;

/// `AdaptiveShellInspector` content and the drawer's panel titlebar.
pub(crate) struct Inspector {
    pub(crate) content: AnyElement,
    pub(crate) titlebar: Option<AnyElement>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent props, as the React AdaptiveShell API"
)]
#[derive(IntoElement)]
pub struct AdaptiveShell {
    pub(crate) id: ElementId,
    pub(crate) window: ShellWindow,
    pub(crate) left_open: bool,
    pub(crate) right_open: bool,
    pub(crate) settings_active: bool,
    pub(crate) resizing: bool,
    pub(crate) transparent_workspace: bool,
    pub(crate) environment: ChromeEnvironment,
    pub(crate) platform: ShellPlatform,
    pub(crate) compact_sidebar_full_width: bool,
    pub(crate) split: Option<SplitConfig>,
    pub(crate) left_peek: bool,
    pub(crate) peek: Option<SidebarPeek>,
    pub(crate) frame: ShellFrame,
    pub(crate) left_width: f32,
    pub(crate) right_width: f32,
    pub(crate) chrome: Option<AnyElement>,
    pub(crate) sidebar: Option<AnyElement>,
    pub(crate) title: Option<AnyElement>,
    pub(crate) workspace: Option<AnyElement>,
    pub(crate) handles: Vec<(HandleSide, AnyElement)>,
    pub(crate) inspector: Option<Inspector>,
    pub(crate) scrim: Option<Callback>,
}

impl AdaptiveShell {
    pub fn new(id: impl Into<ElementId>, window: ShellWindow) -> Self {
        Self {
            id: id.into(),
            window,
            left_open: true,
            right_open: false,
            settings_active: false,
            resizing: false,
            transparent_workspace: false,
            environment: ChromeEnvironment::Browser,
            platform: ShellPlatform::Browser,
            compact_sidebar_full_width: false,
            split: None,
            left_peek: false,
            peek: None,
            frame: ShellFrame::Flat,
            left_width: frame::SIDEBAR_WIDTH,
            right_width: frame::RIGHT_PANEL_WIDTH,
            chrome: None,
            sidebar: None,
            title: None,
            workspace: None,
            handles: Vec::new(),
            inspector: None,
            scrim: None,
        }
    }

    pub fn left_open(mut self, open: bool) -> Self {
        self.left_open = open;
        self
    }

    pub fn right_open(mut self, open: bool) -> Self {
        self.right_open = open;
        self
    }

    /// The settings screen is up: panel motion is off.
    pub fn settings_active(mut self, active: bool) -> Self {
        self.settings_active = active;
        self
    }

    /// A panel resize is under way: panel motion is off.
    pub fn resizing(mut self, resizing: bool) -> Self {
        self.resizing = resizing;
        self
    }

    pub fn transparent_workspace(mut self, transparent: bool) -> Self {
        self.transparent_workspace = transparent;
        self
    }

    pub fn chrome_environment(mut self, environment: ChromeEnvironment) -> Self {
        self.environment = environment;
        self
    }

    pub fn platform(mut self, platform: ShellPlatform) -> Self {
        self.platform = platform;
        self
    }

    /// At compact widths the sidebar drawer covers the window (`100vw`).
    pub fn compact_sidebar_full_width(mut self, full: bool) -> Self {
        self.compact_sidebar_full_width = full;
        self
    }

    /// The conversation frame shows the browser pane: the inspector stays closed while it does.
    pub fn split(mut self, split: SplitConfig) -> Self {
        self.split = Some(split);
        self
    }

    /// The collapsed sidebar floats over the workspace as a card (docked layout only).
    pub fn left_peek(mut self, peek: bool) -> Self {
        self.left_peek = peek;
        self
    }

    /// The hover peek of the collapsed sidebar: its edge zone, dismissal and state.
    pub fn peek(mut self, peek: SidebarPeek) -> Self {
        self.peek = Some(peek);
        self
    }

    pub fn frame(mut self, frame: ShellFrame) -> Self {
        self.frame = frame;
        self
    }

    /// `--sidebar-width` and `--right-panel-width` (`adaptivePanelStyle`).
    pub fn panel_widths(mut self, left: f32, right: f32) -> Self {
        self.left_width = left;
        self.right_width = right;
        self
    }

    pub fn chrome(mut self, chrome: impl IntoElement) -> Self {
        self.chrome = Some(chrome.into_any_element());
        self
    }

    pub fn sidebar(mut self, sidebar: impl IntoElement) -> Self {
        self.sidebar = Some(sidebar.into_any_element());
        self
    }

    /// `AdaptiveShellTitle`: pinned over the workspace's first row.
    pub fn title(mut self, title: impl IntoElement) -> Self {
        self.title = Some(title.into_any_element());
        self
    }

    /// The content under the title row (a card, or the split).
    pub fn workspace(mut self, workspace: impl IntoElement) -> Self {
        self.workspace = Some(workspace.into_any_element());
        self
    }

    /// A panel's resize handle over its divider.
    pub fn resize_handle(mut self, side: HandleSide, handle: impl IntoElement) -> Self {
        self.handles.push((side, handle.into_any_element()));
        self
    }

    pub fn inspector(mut self, content: impl IntoElement) -> Self {
        self.inspector = Some(Inspector {
            content: content.into_any_element(),
            titlebar: None,
        });
        self
    }

    /// The compact inspector's title row.
    pub fn inspector_titlebar(mut self, titlebar: impl IntoElement) -> Self {
        if let Some(inspector) = self.inspector.as_mut() {
            inspector.titlebar = Some(titlebar.into_any_element());
        }
        self
    }

    /// The drawer's backdrop: a press calls `on_dismiss`.
    pub fn scrim(mut self, on_dismiss: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.scrim = Some(Rc::new(on_dismiss));
        self
    }
}

impl RenderOnce for AdaptiveShell {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        layout::render(self, window, cx)
    }
}
