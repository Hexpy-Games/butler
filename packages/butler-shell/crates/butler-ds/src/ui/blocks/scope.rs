//! What a shell passes down its subtree, as CSS custom properties and the frame context do:
//! the frame (`ShellFrameContext`), the title row's insets, colour tokens a subtree re-points
//! (the shell text tones) and a sidebar density. A [`Scope`] sets them while its child lays
//! out, which is when the DS components below it read them.
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window,
};

use crate::tokens::{Color, Density};
use crate::ui::context::Ds;

/// How the app shell frames its content (shellFrame.ts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShellFrame {
    /// The sidebar | the title bar over the workspace: square, one window frame.
    #[default]
    Flat,
    /// The sidebar, window chrome and title row are one shell surface; content sits in rounded
    /// cards inset from the window edges (docked layout only).
    Cards,
}

/// The properties an AdaptiveShell root declares for the blocks inside it.
#[derive(Clone, Copy, Debug)]
pub struct ShellVars {
    pub frame: ShellFrame,
    /// `--titlebar-collapsed-left-padding`: the title's start inset beside a collapsed sidebar.
    pub collapsed_left_padding: f32,
    /// `--window-controls-width`: the app-drawn window controls the title row leaves room for.
    pub window_controls_width: f32,
    /// `--chrome-floating-toggle-left`: the floating sidebar toggle's left edge.
    pub chrome_toggle_left: f32,
    /// The cards frame in the docked layout: the title row sits on the shell surface
    /// (`--titlebar-bg` is clear) and content cards draw their own edge.
    pub cards_docked: bool,
    /// A transparent workspace (a wallpaper behind): the title row and the cards are clear.
    pub transparent_workspace: bool,
    /// The split's pane motion, when the shell has a split.
    pub split: Option<SplitMotion>,
    /// The collapsed sidebar floats over the workspace as a peek card: its content shows.
    pub sidebar_peek: bool,
    /// `--titlebar-card-start` / `--titlebar-card-end`: where the cards start and end in the
    /// title row (the cards frame).
    pub card_start: f32,
    pub card_end: f32,
}

/// How far the browser pane is open (0 closed, 1 open) and the chat column's width beside it:
/// the split, the title row's chat group and the content under them move on one motion.
#[derive(Clone, Copy, Debug)]
pub struct SplitMotion {
    pub motion: Option<crate::ui::motion::Transition>,
    pub fade_motion: Option<crate::ui::motion::Transition>,
    pub progress: f32,
    /// The motion is a fade (reduced motion): geometry is placed at once.
    pub fade: f32,
    pub open: bool,
    pub chat_width: f32,
}

/// What a ConversationShell tells the scroll, message list and jump button inside it.
#[derive(Clone, Debug, Default)]
pub struct ConversationVars {
    pub motion_id: Option<ElementId>,
    /// `--composer-reserve`: the room kept under the messages for the composer.
    pub composer_reserve: f32,
    /// The conversation's width, once measured (0 before): the column's maths read it.
    pub width: f32,
    /// The message column's width and its left edge, once measured.
    pub column_width: f32,
    pub column_left: f32,
    /// `--conversation-column-shift` (animated): how far the column has moved aside.
    pub column_shift: f32,
    /// The top padding of the message list (the title bar's room, or the card's inset).
    pub top_reserve: f32,
}

#[derive(Default)]
struct Conversations(Vec<ConversationVars>);

impl gpui::Global for Conversations {}

/// The enclosing conversation's layout facts, if the caller is inside one.
pub fn conversation(cx: &App) -> Option<ConversationVars> {
    cx.try_global::<Conversations>()
        .and_then(|scopes| scopes.0.last().cloned())
}

#[derive(Default)]
struct Scopes(Vec<ShellVars>);

/// How many sidebar-density scopes enclose the layout in progress.
#[derive(Default)]
struct Densities(usize);

impl gpui::Global for Densities {}

/// Whether the caller is inside a sidebar whose density sets the row tokens.
pub fn in_density(cx: &App) -> bool {
    cx.try_global::<Densities>()
        .is_some_and(|depth| depth.0 > 0)
}

impl gpui::Global for Scopes {}

/// The innermost enclosing shell's properties, if the caller is inside one.
pub fn vars(cx: &App) -> Option<ShellVars> {
    cx.try_global::<Scopes>()
        .and_then(|scopes| scopes.0.last().copied())
}

/// The frame of the enclosing shell (`flat` outside one): blocks use it to draw their card mode.
pub fn frame(cx: &App) -> ShellFrame {
    vars(cx).map_or(ShellFrame::Flat, |vars| vars.frame)
}

/// `--icon-button-size` and the size of the svg inside the buttons of a subtree (the title
/// row's actions, the floating sidebar toggle): an IconButton in it takes both.
#[derive(Clone, Copy, Debug)]
pub struct ActionScale {
    pub side: f32,
    pub icon: f32,
    /// The size holds in a compact window too: a Clickable's rule for the buttons in it
    /// outranks the compact hit target.
    pub fixed: bool,
}

#[derive(Default)]
struct Scales(Vec<ActionScale>);

impl gpui::Global for Scales {}

/// The icon-button size of the enclosing scope, if one sets it.
pub fn action_scale(cx: &App) -> Option<ActionScale> {
    cx.try_global::<Scales>()
        .and_then(|scales| scales.0.last().copied())
}

/// `--nav-hover-bg` / `--nav-selected-bg`: the colour tokens a surface points its nav rows at.
#[derive(Default)]
struct NavFills(Vec<(Color, Color)>);

impl gpui::Global for NavFills {}

/// The (hover, selected) tokens the enclosing surface points nav rows at, if it sets any.
pub fn nav_fills(cx: &App) -> Option<(Color, Color)> {
    cx.try_global::<NavFills>()
        .and_then(|fills| fills.0.last().copied())
}

/// How far the row around the caller shows its swapped-in actions (0 at rest, 1 on hover or
/// keyboard focus): `NavRowSwap` reads it, as the CSS reads `.row:hover`.
#[derive(Default)]
struct Reveals(Vec<f32>);

impl gpui::Global for Reveals {}

/// The enclosing row's reveal, if the caller is inside a row.
pub fn row_reveal(cx: &App) -> Option<f32> {
    cx.try_global::<Reveals>()
        .and_then(|reveals| reveals.0.last().copied())
}

/// The side every svg in a sidebar takes (`.shell svg`), whatever size it asked for.
#[derive(Default)]
struct SvgSizes(Vec<f32>);

impl gpui::Global for SvgSizes {}

/// The enclosing sidebar's svg size, if the caller is inside one.
pub fn svg_size(cx: &App) -> Option<f32> {
    cx.try_global::<SvgSizes>()
        .and_then(|sizes| sizes.0.last().copied())
}

/// What a ComposerCard tells the controls and panels in it: its `container-type: inline-size`
/// facts and the `--composer-inner-padding-*` variables.
#[derive(Clone, Copy, Debug, Default)]
pub struct ComposerVars {
    /// `@container composer (width <= 520px)`: the control row tightens.
    pub narrow: bool,
    /// The card's inner padding (inline, block).
    pub padding: (f32, f32),
    /// `data-expanded`: the editor and its controls show; folded, a one-line preview does.
    pub expanded: bool,
}

#[derive(Default)]
struct Composers(Vec<ComposerVars>);

impl gpui::Global for Composers {}

/// The enclosing composer card's facts, if the caller is inside one.
pub fn composer(cx: &App) -> Option<ComposerVars> {
    cx.try_global::<Composers>()
        .and_then(|vars| vars.0.last().copied())
}

/// What a [`Scope`] sets for its child.
#[derive(Clone, Default)]
pub struct Spec {
    pub svg_size: Option<f32>,
    pub nav_fills: Option<(Color, Color)>,
    pub row_reveal: Option<f32>,
    pub action: Option<ActionScale>,
    pub conversation: Option<ConversationVars>,
    pub vars: Option<ShellVars>,
    pub composer: Option<ComposerVars>,
    /// The subtree renders in this theme (`theme-dark` or `theme-light`), whatever the page's.
    pub dark: Option<bool>,
    pub remap: Vec<(Color, Color)>,
    pub density: Option<Density>,
}

pub struct Scope {
    spec: Spec,
    child: Option<AnyElement>,
}

/// `child` laid out with `spec` in effect.
pub fn scoped(spec: Spec, child: impl IntoElement) -> Scope {
    Scope {
        spec,
        child: Some(child.into_any_element()),
    }
}

impl IntoElement for Scope {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Scope {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        let layout = within(&self.spec, window, cx, |window, cx| {
            child.request_layout(window, cx)
        });
        (layout, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        // Lists render their rows here, so the scope holds for prepaint as it does for layout
        // (CSS custom properties inherit in every phase).
        within(&self.spec, window, cx, |window, cx| {
            child.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        within(&self.spec, window, cx, |window, cx| child.paint(window, cx));
    }
}

/// Runs `f` with the scope's theme remap, density, darkness and globals applied.
fn within<R>(
    spec: &Spec,
    window: &mut Window,
    cx: &mut App,
    f: impl FnOnce(&mut Window, &mut App) -> R,
) -> R {
    let (mark, density, dark) = {
        let mut saved = (0, Density::default(), false);
        Ds::update(cx, |ds| {
            saved = (ds.begin_remap(&spec.remap), ds.density(), ds.dark());
            if let Some(density) = spec.density {
                ds.set_density(density);
            }
            if let Some(dark) = spec.dark {
                ds.set_dark(dark);
            }
        });
        saved
    };
    push_globals(spec, cx);
    let out = f(window, cx);
    pop_globals(spec, cx);
    Ds::update(cx, |ds| {
        ds.end_remap(mark);
        ds.set_density(density);
        ds.set_dark(dark);
    });
    out
}

/// Pushes the scope's overrides onto their globals for the child's layout.
fn push_globals(spec: &Spec, cx: &mut App) {
    if let Some(vars) = spec.vars {
        cx.default_global::<Scopes>().0.push(vars);
    }
    if spec.density.is_some() {
        cx.default_global::<Densities>().0 += 1;
    }
    if let Some(vars) = &spec.conversation {
        cx.default_global::<Conversations>().0.push(vars.clone());
    }
    if let Some(scale) = spec.action {
        cx.default_global::<Scales>().0.push(scale);
    }
    if let Some(fills) = spec.nav_fills {
        cx.default_global::<NavFills>().0.push(fills);
    }
    if let Some(side) = spec.svg_size {
        cx.default_global::<SvgSizes>().0.push(side);
    }
    if let Some(reveal) = spec.row_reveal {
        cx.default_global::<Reveals>().0.push(reveal);
    }
    if let Some(vars) = spec.composer {
        cx.default_global::<Composers>().0.push(vars);
    }
}

/// Pops what `push_globals` pushed, in the reverse order.
fn pop_globals(spec: &Spec, cx: &mut App) {
    if spec.action.is_some() {
        cx.default_global::<Scales>().0.pop();
    }
    if spec.nav_fills.is_some() {
        cx.default_global::<NavFills>().0.pop();
    }
    if spec.svg_size.is_some() {
        cx.default_global::<SvgSizes>().0.pop();
    }
    if spec.composer.is_some() {
        cx.default_global::<Composers>().0.pop();
    }
    if spec.row_reveal.is_some() {
        cx.default_global::<Reveals>().0.pop();
    }
    if spec.vars.is_some() {
        cx.default_global::<Scopes>().0.pop();
    }
    if spec.density.is_some() {
        cx.default_global::<Densities>().0 -= 1;
    }
    if spec.conversation.is_some() {
        cx.default_global::<Conversations>().0.pop();
    }
}
