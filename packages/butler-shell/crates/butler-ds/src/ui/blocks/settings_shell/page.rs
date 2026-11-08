//! DS settingsPage.tsx: the page copy a settings section renders under (the title and description
//! the page header already shows), and the rule for when section copy repeats it.
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, SharedString, Window,
};

/// The title and description the page header shows.
#[derive(Clone, Debug, Default)]
pub struct SettingsPageCopy {
    pub title: Option<SharedString>,
    pub description: Option<SharedString>,
}

#[derive(Default)]
struct Pages(Vec<SettingsPageCopy>);

impl gpui::Global for Pages {}

/// The enclosing page's copy (`useSettingsPage`), if the caller is inside a provider.
pub fn settings_page(cx: &App) -> Option<SettingsPageCopy> {
    cx.try_global::<Pages>()
        .and_then(|pages| pages.0.last().cloned())
}

/// `SettingsPageProvider`: `child` laid out with `copy` as its page.
pub fn settings_page_provider(copy: SettingsPageCopy, child: impl IntoElement) -> PageScope {
    PageScope {
        copy,
        child: Some(child.into_any_element()),
    }
}

pub struct PageScope {
    copy: SettingsPageCopy,
    child: Option<AnyElement>,
}

impl IntoElement for PageScope {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

fn within<R>(copy: &SettingsPageCopy, cx: &mut App, f: impl FnOnce(&mut App) -> R) -> R {
    cx.default_global::<Pages>().0.push(copy.clone());
    let out = f(cx);
    cx.default_global::<Pages>().0.pop();
    out
}

impl Element for PageScope {
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
        let layout = within(&self.copy, cx, |cx| child.request_layout(window, cx));
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
        within(&self.copy, cx, |cx| child.prepaint(window, cx));
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
        within(&self.copy, cx, |cx| child.paint(window, cx));
    }
}

/// A reference this many words or longer (a description) also repeats when a candidate only
/// extends it.
const PREFIX_MIN_WORDS: usize = 3; // DS: settingsPage.tsx:30

/// Case, whitespace and trailing sentence punctuation do not make copy distinct.
fn normalize(value: &str) -> String {
    let words: Vec<&str> = value.split_whitespace().collect();
    let joined = words.join(" ");
    let end = |c: char| c.is_whitespace() || ".。!！?？:：…".contains(c);
    joined.trim_end_matches(end).to_lowercase()
}

/// Whether section copy repeats the page copy: equal after normalization, or, for descriptions,
/// the page description followed by more words. Short titles only match exactly.
pub fn repeats_settings_copy(candidate: Option<&str>, reference: Option<&str>) -> bool {
    let (Some(candidate), Some(reference)) = (candidate, reference) else {
        return false;
    };
    let (value, page) = (normalize(candidate), normalize(reference));
    if value.is_empty() || page.is_empty() {
        return false;
    }
    value == page
        || (page.split(' ').count() >= PREFIX_MIN_WORDS && value.starts_with(&format!("{page} ")))
}
