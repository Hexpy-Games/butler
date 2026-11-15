//! `BrowserToolbar` (BrowserPane.tsx / BrowserPane.module.css `.toolbar`): navigation, the
//! address and the page actions on one row, aligned to the page card's edges. The row is one
//! `--browser-band-height` plus two `--space-xs` tall, so the 34px address field sits 7px below
//! the tabs and centres with the 28px buttons.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window,
    div,
};

use crate::tokens::Length;
use crate::ui::blocks::measure;
use crate::ui::button::{self, Size};
use crate::ui::context::Ds;
use crate::ui::strut;

/// `@container browser-toolbar (width < 520px)`: the toolbar's content width.
const NARROW: f32 = 520.; // DS: BrowserPane.module.css:101

#[derive(IntoElement)]
pub struct BrowserToolbar {
    id: ElementId,
    navigation: Vec<AnyElement>,
    address: Option<AnyElement>,
    actions: Vec<AnyElement>,
}

impl BrowserToolbar {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            navigation: Vec::new(),
            address: None,
            actions: Vec::new(),
        }
    }

    /// Back, forward, reload/stop: IconButtons, in a `ButtonContainer size="icon-sm"`.
    pub fn navigation(mut self, button: impl IntoElement) -> Self {
        self.navigation.push(button.into_any_element());
        self
    }

    /// The AddressField; it takes the remaining width.
    pub fn address(mut self, address: impl IntoElement) -> Self {
        self.address = Some(address.into_any_element());
        self
    }

    /// A page action (pick, scrap, bookmarks, downloads, more), in one
    /// `ButtonContainer size="icon-sm"`. Make the last one More, which carries the others: it
    /// is the only one a narrow toolbar keeps.
    pub fn action(mut self, button: impl IntoElement) -> Self {
        self.actions.push(button.into_any_element());
        self
    }
}

fn group(buttons: Vec<AnyElement>) -> gpui::Div {
    div().flex().flex_none().items_center().child(
        button::container(Size::IconSm)
            .wrap(false)
            .children(buttons),
    )
}

impl RenderOnce for BrowserToolbar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (seen, recorder) = measure::track((self.id.clone(), "toolbar"), window, cx);
        let ds = Ds::get(cx);
        let inset = ds.len(Length::BrowserCardInset);
        // The recorder fills the padding box; a container query reads the content box.
        let narrow = seen.width > gpui::px(0.) && f32::from(seen.width - inset * 2.) < NARROW;
        let mut actions = self.actions;
        if narrow {
            // `.group:last-child [data-slot="button-container"] > :not(:last-child)`.
            let last = actions.pop();
            actions = last.into_iter().collect();
        }
        let address = div().flex().flex_auto().min_w_0();
        let address = if narrow {
            address.min_w(ds.len(Length::Space4xl) * 3.)
        } else {
            address
        };
        strut::scope(
            false,
            div()
                .relative()
                .flex()
                .flex_none()
                .min_w_0()
                .items_center()
                .gap(ds.len(Length::SpaceSm))
                .h(ds.len(Length::BrowserBandHeight) + ds.len(Length::SpaceXs) * 2.)
                .px(inset)
                .py(ds.len(Length::SpaceXs))
                .child(recorder)
                .child(group(self.navigation))
                .child(address.children(self.address))
                .children((!actions.is_empty()).then(|| group(actions))),
        )
    }
}
