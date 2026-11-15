//! The shell window's stable parts, each rendered as its own cached view, so an animation inside
//! one (a spinner, a progress ring) rebuilds that part and not the whole window.
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, Render, StyleRefinement,
    Styled as _, Subscription, WeakEntity, Window, div,
};

use super::Shell;

/// How a region builds its element from the shell.
type RenderFn = fn(&mut Shell, &mut Window, &mut Context<Shell>) -> AnyElement;

/// A stable part of the shell window rendered as its own cached view. It re-renders when the
/// shell notifies (its state changed) or when an animation inside it asks for a frame, so a
/// spinner in one region doesn't rebuild the others.
pub(crate) struct Region {
    shell: WeakEntity<Shell>,
    render: RenderFn,
    _shell_changed: Subscription,
}

impl Region {
    /// A region that draws `render` of `shell`, and re-renders whenever the shell notifies.
    pub(super) fn new(shell: &Entity<Shell>, render: RenderFn, cx: &mut Context<Self>) -> Self {
        Self {
            shell: shell.downgrade(),
            render,
            _shell_changed: cx.observe(shell, |_, _, cx| cx.notify()),
        }
    }
}

impl Render for Region {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let render = self.render;
        self.shell
            .update(cx, |shell, cx| render(shell, window, cx))
            .unwrap_or_else(|_| div().into_any_element())
    }
}

/// The regions a live event touched; see [`Regions::notify`].
#[derive(Clone, Copy, Default)]
pub(super) struct Touched {
    pub(super) sidebar: bool,
    pub(super) titlebar: bool,
    pub(super) conversation: bool,
}

/// The regions the shell composes; each is embedded with [`fill`]. A shell `cx.notify()` redraws
/// all of them. The live path notifies only the regions whose inputs it changed, so each field
/// lists its inputs: a new one that live events change must be flagged in [`Touched`].
pub(super) struct Regions {
    /// The sidebar slot's content. Inputs: `store.navigation`, `store.selected`, `sidebar.*`;
    /// live: navigation events that change the tree, `updates.progress`.
    pub(super) sidebar: Entity<Region>,
    /// The title row. Inputs: `store.summary(selected)`, `session_menu.summary`, the open view's
    /// `view_facts`, `frame.open`; live: chat rows, a change in the view's facts.
    pub(super) titlebar: Entity<Region>,
    /// The chat card with its composer and aside. Inputs: `chat`, `composer`, `panes.view`,
    /// `panes.info_open`, `composer_h`; live: `show_view`.
    pub(super) conversation: Entity<Region>,
    /// The file viewer pane beside the chat. Inputs: `store.selected`, the file viewer state;
    /// not on the live path.
    pub(super) viewer: Entity<Region>,
    pub(super) browser: Entity<Region>,
}

impl Regions {
    /// The regions of `shell`; called while the shell is built.
    pub(super) fn new(shell: &Entity<Shell>, cx: &mut Context<Shell>) -> Self {
        let mut region = |render: RenderFn| cx.new(|cx| Region::new(shell, render, cx));
        Self {
            sidebar: region(Shell::render_sidebar),
            titlebar: region(|shell, window, cx| {
                let open = shell.frame.open;
                shell.render_titlebar(open, window, cx)
            }),
            conversation: region(|shell, window, cx| shell.conversation(window, cx)),
            viewer: region(Shell::render_viewer_pane),
            browser: region(Shell::render_browser_pane),
        }
    }

    /// Redraws the flagged regions only.
    pub(super) fn notify(&self, touched: Touched, cx: &mut App) {
        for (flag, region) in [
            (touched.sidebar, &self.sidebar),
            (touched.titlebar, &self.titlebar),
            (touched.conversation, &self.conversation),
        ] {
            if flag {
                region.update(cx, |_, cx| cx.notify());
            }
        }
    }
}

/// The slot is the parent's whole box (`size_full`).
pub(super) fn fill() -> StyleRefinement {
    StyleRefinement::default().size_full()
}
