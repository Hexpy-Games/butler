//! Stand-ins for the blocks the ContextMenu and Select showcases still use (MessageRow `system`,
//! ProviderLogo). They follow the React CSS they replace, draw from tokens and go away when the
//! blocks land. They are not part of `butler-ds`.
use butler_ds::tokens::Length;
use butler_ds::ui::context::Ds;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, div, px};

/// MessageRow with `role="system"` and `compactionEvent` (MessageRow.module.css `.row`,
/// `.compactionEvent`, `.body`): the summary line of compacted turns.
pub(crate) fn message_row_system(text: &'static str, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .pt(ds.len(Length::SpaceXl))
        .pb(px(28.)) // DS: MessageRow.module.css:32
        .child(
            div()
                .min_w_0()
                .pt(px(2.)) // DS: MessageRow.module.css:44
                .text_size(ds.len(Length::FontSize3))
                .line_height(ds.len(Length::TypoBodyLineHeightDocument))
                .child(text),
        )
        .into_any_element()
}

/// ProviderLogo (ProviderLogo.module.css): the service logo, a 16px box. The vendored SVGs are
/// not ported, so this draws a neutral mark in the same box.
pub(crate) fn provider_logo(_name: &'static str) -> AnyElement {
    let side = px(16.); // DS: ProviderLogo.module.css:4 (`--icon-size-md`)
    div().size(side).flex_none().into_any_element()
}
