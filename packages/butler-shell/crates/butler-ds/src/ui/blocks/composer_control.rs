//! DS ComposerControl (ComposerControl.tsx / ComposerControl.module.css): a pill in the composer
//! toolbar with an icon, a caption label and an optional detail. In a narrow composer (a
//! `composer` container of 520px or less) the detail goes and an icon-only control is a circle.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::blocks::scope;
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Disabled, Width};
use crate::ui::pill_button::PillButton;
use crate::ui::typo::{Tone, Typo};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `compact`: what the control keeps in a narrow composer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Compact {
    #[default]
    Label,
    Icon,
}

/// `tone`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ControlTone {
    #[default]
    Default,
    /// An error state in the danger colour.
    Danger,
}

/// `permissionTone`: access-mode colours for the control and its icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionTone {
    Full,
    Ask,
    Read,
}

impl PermissionTone {
    /// The icon's colour token.
    pub fn icon(self) -> Color {
        match self {
            Self::Full => Color::AccessFull,
            Self::Ask => Color::AccessAsk,
            Self::Read => Color::AccessReadIcon,
        }
    }

    /// The text colour token.
    pub fn text(self) -> Color {
        match self {
            Self::Full => Color::AccessFull,
            Self::Ask => Color::AccessAsk,
            Self::Read => Color::AccessRead,
        }
    }
}

#[derive(IntoElement)]
pub struct ComposerControl {
    id: ElementId,
    icon: Option<AnyElement>,
    label: SharedString,
    detail: Option<SharedString>,
    active: bool,
    compact: Compact,
    tone: ControlTone,
    permission: Option<PermissionTone>,
    disabled: bool,
    aria_disabled: bool,
    on_click: Option<Handler>,
}

impl ComposerControl {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            label: label.into(),
            detail: None,
            active: false,
            compact: Compact::Label,
            tone: ControlTone::Default,
            permission: None,
            disabled: false,
            aria_disabled: false,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    pub fn compact(mut self, compact: Compact) -> Self {
        self.compact = compact;
        self
    }

    pub fn tone(mut self, tone: ControlTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn permission_tone(mut self, tone: PermissionTone) -> Self {
        self.permission = Some(tone);
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// `aria-disabled`: focusable and hoverable (a tooltip names why), activation blocked.
    pub fn aria_disabled(mut self) -> Self {
        self.aria_disabled = true;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ComposerControl {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let narrow = scope::composer(cx).is_some_and(|vars| vars.narrow);
        let icon_only = narrow && self.compact == Compact::Icon;
        let danger = self.tone == ControlTone::Danger;
        let label_tone = if danger { Tone::Danger } else { Tone::Primary };
        let glyph_color = match (danger, self.permission) {
            (true, _) => Some(ds.color(Color::Danger)),
            (false, Some(tone)) => Some(ds.color(tone.icon())),
            (false, None) => None,
        };
        let mut pill = PillButton::new(self.id.clone());
        if let Some(icon) = self.icon {
            let glyph = div().flex().items_center().justify_center().child(icon);
            pill = pill.icon(match glyph_color {
                Some(color) => glyph.text_color(color),
                None => glyph,
            });
        }
        if !icon_only {
            pill = pill.child(
                div()
                    .flex()
                    .items_center()
                    .gap(ds.len(Length::SpaceXs))
                    .min_w_0()
                    .child(
                        div()
                            .min_w_0()
                            .child(Typo::caption(self.label).tone(label_tone).truncate()),
                    )
                    .children(
                        self.detail
                            .filter(|_| !narrow)
                            .map(|detail| Typo::caption(detail).tone(Tone::Tertiary).truncate()),
                    ),
            );
        }
        if self.disabled {
            pill = pill.disabled();
        }
        let mut control = pill.control(ds);
        if self.aria_disabled {
            control.disabled = Disabled::Aria;
        }
        control.on_click(self.on_click);
        if self.active {
            control.fill = Blend::flat(ds.color(Color::SelectionStrong));
        }
        // `.control[data-tone="danger"]` and the permission tones colour the control itself.
        if danger {
            control.fg = Blend::flat(ds.color(Color::Danger));
        } else if let Some(tone) = self.permission {
            control.fg = Blend::flat(ds.color(tone.text()));
        }
        // Touch widths: the pill keeps its visual control height, not the hit target's.
        if ds.compact() {
            control.min_height = Some(ds.len(Length::ControlHeightMd));
        }
        let round = ds.len(Length::ControlHeightMd);
        if narrow {
            control.padding = [
                ds.len(Length::SpaceSm),
                control.padding[1],
                ds.len(Length::SpaceSm),
                control.padding[3],
            ];
        }
        if icon_only {
            control.width = Width::Fixed(f32::from(round));
            control.padding = [px(0.); 4];
        }
        control.outer = Some(Box::new(|el| el.self_center().max_w(px(220.)))); // DS: ComposerControl.module.css:3
        control
    }
}
