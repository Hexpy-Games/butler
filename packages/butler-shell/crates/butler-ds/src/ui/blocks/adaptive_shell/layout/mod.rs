//! Assembling an AdaptiveShell: the geometry of the docked layout (the grid of the CSS, with the
//! sidebar and inspector sliding over it) and the shared facts both layouts use.
use gpui::{
    AnyElement, App, Div, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::frame_cfg::{HandleSide, ShellPlatform};
use super::grip::HANDLE_WIDTH;
use super::track::{self, Facts, Tracks};
use super::{AdaptiveShell, ShellFrame};
use crate::tokens::{Color, Length};
use crate::ui::blocks::responsive::{self, ChromeEnvironment};
use crate::ui::blocks::scope::{self, ShellVars, Spec};
use crate::ui::context::Ds;
use crate::ui::strut;

mod drawer;
mod peek;

/// The linux window keeps a 1px frame around the shell (`--app-window-frame-inset`).
const LINUX_FRAME_INSET: f32 = 1.; // DS: AdaptiveShell.module.css:71
/// The traffic lights' reserve is the token's; the Windows and Linux controls are 138px wide.
const WINDOW_CONTROLS: f32 = 138.; // DS: AdaptiveShell.module.css:62
/// The workspace's leading corners with a docked sidebar (`calc(18px / var(--ui-scale))`).
const WORKSPACE_RADIUS: f32 = 18.; // DS: AdaptiveShell.module.css:33
/// How far a peeking sidebar travels in (`--motion-distance-md`) is a token; the card's inset is
/// `--space-sm`.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent layout facts, as the CSS data attributes of the shell"
)]
pub(super) struct Ctx {
    pub(super) drawer: bool,
    pub(super) cards: bool,
    pub(super) electron: bool,
    pub(super) inset: f32,
    pub(super) safe_top: f32,
    pub(super) left_w: f32,
    pub(super) right_w: f32,
    pub(super) t: Tracks,
    pub(super) vars: ShellVars,
    pub(super) inspector_open: bool,
    pub(super) peeking: bool,
    pub(super) reduced: bool,
    pub(super) borderless: bool,
}

/// The colour tokens a platform's shell material re-points (AdaptiveShell.module.css:44-79).
fn platform_remap(environment: ChromeEnvironment, platform: ShellPlatform) -> Vec<(Color, Color)> {
    match (environment, platform) {
        (ChromeEnvironment::Electron, ShellPlatform::Darwin) => vec![
            (Color::SidebarBg, Color::MacSidebarBg),
            (Color::SidebarHoverBg, Color::MacSidebarHoverBg),
            (Color::SidebarSelectedBg, Color::MacSidebarSelectedBg),
            (Color::SidebarTextSecondary, Color::MacSidebarTextSecondary),
            (Color::SidebarTextTertiary, Color::MacSidebarTextTertiary),
        ],
        (ChromeEnvironment::Electron, ShellPlatform::Win32) => vec![
            (Color::SidebarBg, Color::WindowsSidebarBg),
            (Color::SidebarHoverBg, Color::WindowsSidebarHoverBg),
            (Color::SidebarSelectedBg, Color::WindowsSidebarSelectedBg),
            (
                Color::SidebarTextSecondary,
                Color::WindowsSidebarTextSecondary,
            ),
            (
                Color::SidebarTextTertiary,
                Color::WindowsSidebarTextTertiary,
            ),
        ],
        _ => Vec::new(),
    }
}

/// Text on the translucent shell takes the shell's text tones (the sidebar, and the cards
/// frame's title row).
pub(super) fn shell_tones() -> Vec<(Color, Color)> {
    vec![
        (Color::TextSecondary, Color::SidebarTextSecondary),
        (Color::TextTertiary, Color::SidebarTextTertiary),
        (Color::ColorTextSecondary, Color::SidebarTextSecondary),
        (Color::ColorTextTertiary, Color::SidebarTextTertiary),
        (Color::MutedForeground, Color::SidebarTextSecondary),
        (Color::MenuGroupLabelColor, Color::SidebarTextTertiary),
    ]
}

/// A panel on the panel surface (a drawer, the peek card): its rows keep the selection shades.
pub(super) fn panel_rows() -> Vec<(Color, Color)> {
    vec![
        (Color::SidebarHoverBg, Color::Selection),
        (Color::SidebarSelectedBg, Color::SelectionStrong),
    ]
}

fn shell_vars(
    shell: &AdaptiveShell,
    drawer: bool,
    ds: &Ds,
    split: Option<scope::SplitMotion>,
) -> ShellVars {
    let electron = shell.environment == ChromeEnvironment::Electron;
    let traffic = if electron && shell.platform == ShellPlatform::Darwin && !shell.window.fullscreen
    {
        f32::from(ds.len(Length::TrafficControlsWidth))
    } else {
        0.
    };
    let toggle_left = traffic + f32::from(ds.len(Length::ChromeToggleInset));
    let toggle = f32::from(ds.len(Length::ChromeFloatingToggleSize));
    let cards = shell.frame == ShellFrame::Cards && !drawer;
    let inset = f32::from(ds.len(Length::ShellCardInset) - ds.len(Length::BorderHairline));
    ShellVars {
        frame: shell.frame,
        collapsed_left_padding: toggle_left + toggle + f32::from(ds.len(Length::SpaceMd)),
        window_controls_width: if electron
            && matches!(shell.platform, ShellPlatform::Linux | ShellPlatform::Win32)
        {
            WINDOW_CONTROLS
        } else {
            0.
        },
        chrome_toggle_left: toggle_left,
        cards_docked: cards,
        transparent_workspace: shell.transparent_workspace,
        split,
        sidebar_peek: false,
        card_start: 0.,
        card_end: if cards { inset } else { 0. },
    }
}

pub(super) fn render(mut shell: AdaptiveShell, window: &mut Window, cx: &mut App) -> AnyElement {
    let drawer = responsive::drawer(shell.window.width, shell.environment);
    let inspector_open = shell.right_open && !shell.split.is_some_and(|split| split.open);
    let peek_open = shell.left_peek || shell.peek.as_ref().is_some_and(|peek| peek.open(cx));
    let peeking = peek_open && !shell.left_open && !drawer;
    let facts = Facts {
        drawer,
        inspector_open,
        peeking,
        scrim_open: shell.left_open || inspector_open,
    };
    let t = track::tracks(&shell, &facts, window, cx);
    let ds = Ds::get(cx);
    let electron = shell.environment == ChromeEnvironment::Electron;
    let mut vars = shell_vars(&shell, drawer, ds, t.split);
    vars.sidebar_peek = peeking;
    let inset = if electron && shell.platform == ShellPlatform::Linux {
        LINUX_FRAME_INSET
    } else {
        0.
    };
    let ctx = Ctx {
        drawer,
        cards: vars.cards_docked,
        electron,
        inset,
        safe_top: f32::from(ds.len(Length::TitlebarSafeAreaTop)),
        left_w: shell.left_width,
        right_w: shell.right_width,
        t,
        vars,
        inspector_open,
        peeking,
        reduced: ds.reduced_motion(),
        borderless: drawer && shell.window.width <= responsive::COMPACT_MAX,
    };
    let remap = platform_remap(shell.environment, shell.platform);
    let root = if ctx.drawer {
        drawer::root(&mut shell, &ctx, cx)
    } else {
        docked(&mut shell, &ctx, window, cx)
    };
    let spec = Spec {
        vars: Some(ctx.vars),
        remap,
        ..Spec::default()
    };
    strut::scope(false, scope::scoped(spec, root)).into_any_element()
}

/// The shell surface under everything: the sidebar's material, or the settings background.
pub(super) fn root_bg(shell: &AdaptiveShell, cards: bool, ds: &Ds) -> gpui::Hsla {
    let sidebar = match (shell.environment, shell.platform) {
        (ChromeEnvironment::Electron, ShellPlatform::Darwin) => Color::MacSidebarBg,
        (ChromeEnvironment::Electron, ShellPlatform::Win32) => Color::WindowsSidebarBg,
        _ => Color::SidebarBg,
    };
    if shell.settings_active && !cards {
        ds.color(Color::SettingsBg)
    } else {
        ds.color(sidebar)
    }
}

/// The element every layout starts from: `position: relative; overflow: clip; padding: inset`.
pub(super) fn root_box(shell: &AdaptiveShell, ctx: &Ctx, ds: &Ds) -> Div {
    div()
        .relative()
        .size_full()
        .overflow_hidden()
        .p(px(ctx.inset))
        .bg(root_bg(shell, ctx.cards, ds))
        .text_color(ds.color(Color::TextPrimary))
}

/// The title slot over the workspace's first row. In the cards frame the title row belongs to
/// the shell and reaches over the inspector's column (`right: -track`), so the trailing icons
/// stay at the window edge; its text takes the shell text tones.
fn title_slot(shell: &mut AdaptiveShell, ctx: &Ctx, right_track: f32) -> Option<Div> {
    let right = if ctx.cards { -right_track } else { 0. };
    let title = shell.title.take()?;
    let tones = Spec {
        remap: if ctx.cards { shell_tones() } else { Vec::new() },
        ..Spec::default()
    };
    Some(
        div()
            .absolute()
            .top_0()
            .left_0()
            .right(px(right))
            .h(px(ctx.safe_top))
            .child(scope::scoped(tones, title)),
    )
}

/// The workspace: the title row's room, the body, the title slot over the first row.
pub(super) fn workspace_box(
    shell: &mut AdaptiveShell,
    ctx: &Ctx,
    (left_track, right_track): (f32, f32),
    ds: &Ds,
) -> Div {
    let border = if ctx.borderless {
        px(0.)
    } else {
        ds.len(Length::BorderHairline)
    };
    let hairline = f32::from(ds.len(Length::BorderHairline));
    let inset = f32::from(ds.len(Length::ShellCardInset)) - hairline;
    let body = div()
        .flex()
        .flex_col()
        .flex_auto()
        .min_w_0()
        .min_h_0()
        .children(shell.workspace.take());
    let right_open = ctx.inspector_open;
    let mut ws = div()
        .relative()
        .size_full()
        .min_w_0()
        .min_h_0()
        .flex()
        .flex_col()
        .border_l(border)
        .border_t(border)
        .border_b(border)
        .border_r(if right_open && !ctx.cards {
            px(0.)
        } else {
            border
        });
    ws = if ctx.cards {
        // The cards frame: the workspace is only the shell's room for cards.
        let left = if left_track > 0. { 0. } else { inset };
        ws.border_color(gpui::transparent_black())
            .pr(px(inset))
            .pb(px(inset))
            .pl(px(left))
    } else {
        let radius = if !ctx.electron && left_track > 0. {
            WORKSPACE_RADIUS / ds.tokens().ui_scale
        } else {
            0.
        };
        let surface = if shell.transparent_workspace {
            gpui::transparent_black()
        } else {
            ds.color(Color::WorkspaceBg)
        };
        ws.border_color(ds.color(Color::Line))
            .rounded_tl(px(radius))
            .rounded_bl(px(radius))
            .bg(surface)
            .overflow_hidden()
    };
    let title = title_slot(shell, ctx, right_track);
    ws.child(div().h(px(ctx.safe_top)).flex_none())
        .child(body)
        .children(title)
}

/// A panel handle placed over its divider.
fn handle_at(side: HandleSide, handle: AnyElement, ctx: &Ctx, ds: &Ds) -> Div {
    let el = div()
        .absolute()
        .top(px(ctx.safe_top))
        .bottom_0()
        .w(px(HANDLE_WIDTH));
    match side {
        HandleSide::Left => el.left(px(ctx.left_w - 4.)), // DS: AdaptiveShell.module.css:187
        HandleSide::Right => {
            // The cards frame centres the grab zone in the gap before the inspector's card.
            let gap = f32::from(ds.len(Length::ShellCardGap));
            let offset = if ctx.cards {
                (gap - HANDLE_WIDTH) / 2.
            } else {
                -4.
            }; // DS: AdaptiveShell.module.css:191
            el.right(px(ctx.right_w + offset))
        }
    }
    .child(handle)
}

/// The docked layout: the grid `left | workspace | right` with the panels sliding over it.
fn docked(shell: &mut AdaptiveShell, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let t = &ctx.t;
    // The track follows the committed state: closing is 0 at once, opening commits at the end
    // of the slide, so the workspace reflows once, already in place.
    let settled_open = shell.left_open && t.left >= 0.999;
    let left_track = if settled_open { ctx.left_w } else { 0. };
    let right_track = t.right * ctx.right_w;
    let shift = t.left * ctx.left_w - left_track;
    let moving = shift.abs() > 0.01;
    let workspace = workspace_box(shell, ctx, (left_track, right_track), ds);
    let cell = div()
        .relative()
        .flex_auto()
        .min_w_0()
        .h_full()
        .when_moving(moving)
        .child(
            div()
                .relative()
                .size_full()
                .left(px(shift))
                .child(workspace),
        );
    let mut root = root_box(shell, ctx, ds)
        .flex()
        .flex_row()
        .child(div().w(px(left_track)).flex_none())
        .child(cell)
        .child(div().w(px(right_track)).flex_none());
    root = root.children(sidebar_layer(shell, ctx, window, cx));
    let ds = Ds::get(cx);
    root = root.children(inspector_layer(shell, ctx, ds));
    for (side, handle) in std::mem::take(&mut shell.handles) {
        root = root.child(handle_at(side, handle, ctx, ds));
    }
    root = root.children(peek::sidebar_peek(shell, ctx, cx));
    root.children(shell.chrome.take()).into_any_element()
}

trait WhenMoving: Sized {
    fn when_moving(self, moving: bool) -> Self;
}

impl WhenMoving for Div {
    /// The workspace clips at the cell's edge while it slides (the clip-path of the slide).
    fn when_moving(self, moving: bool) -> Self {
        if moving { self.overflow_hidden() } else { self }
    }
}

/// The docked sidebar: its full width slides on the compositor while the track collapses.
fn sidebar_layer(
    shell: &mut AdaptiveShell,
    ctx: &Ctx,
    _: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let ds = Ds::get(cx);
    let t = &ctx.t;
    let settled_closed = !shell.left_open && t.left <= 0.001 && t.left_fade <= 0.001;
    if ctx.peeking || settled_closed {
        return None;
    }
    let content = shell.sidebar.take()?;
    let reduced = ds.reduced_motion();
    let slide = if reduced {
        0.
    } else {
        (1. - t.left) * ctx.left_w
    };
    let top = if ctx.cards {
        f32::from(ds.len(Length::BorderHairline))
    } else {
        0.
    };
    let tones = Spec {
        remap: shell_tones(),
        ..Spec::default()
    };
    let el = div()
        .absolute()
        .top(px(ctx.inset))
        .bottom(px(ctx.inset))
        .left(px(ctx.inset - slide))
        .w(px(ctx.left_w))
        .pt(px(top))
        .overflow_hidden()
        .child(scope::scoped(tones, content));
    Some(if reduced { el.opacity(t.left_fade) } else { el }.into_any_element())
}

/// The docked inspector: its full width over the right track, sliding in from the edge.
fn inspector_layer(shell: &mut AdaptiveShell, ctx: &Ctx, ds: &Ds) -> Option<AnyElement> {
    let t = &ctx.t;
    if !ctx.inspector_open && t.right <= 0.001 && t.right_fade <= 0.001 {
        return None;
    }
    let inspector = shell.inspector.take()?;
    Some(drawer::docked_inspector(inspector.content, ctx, ds))
}
