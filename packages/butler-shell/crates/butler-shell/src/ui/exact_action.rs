//! Code text wraps only at whitespace, then at Unicode boundaries for oversized tokens.
//! Layout slices the original string; no hyphen substitution or inserted text.
use crate::ui::theme::Theme;
use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, ShapedText, SharedString, Style, TextAlign, TextRun, Window,
    font, point, px, relative, size,
};

#[derive(Clone)]
pub(crate) struct ExactAction {
    text: SharedString,
    theme: Theme,
    font_size: f32,
    line_height: f32,
}
pub(crate) fn exact_action(text: SharedString, theme: &Theme, scale: f32) -> ExactAction {
    ExactAction {
        text,
        theme: theme.clone(),
        font_size: 13. * scale,
        line_height: 18. * scale,
    }
}
impl IntoElement for ExactAction {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl ExactAction {
    fn shape(&self, text: &str, window: &mut Window) -> Option<ShapedText> {
        let run = TextRun {
            len: text.len(),
            font: font(self.theme.code_font.clone()),
            color: self.theme.text,
            ..Default::default()
        };
        window
            .text_system()
            .shape_text(text.to_owned(), px(self.font_size), &[run], None, None)
            .ok()
    }
    fn rows(&self, width: Pixels, window: &mut Window) -> Vec<ShapedText> {
        let mut rows = Vec::new();
        for line in self.text.split('\n') {
            let mut rest = line;
            while !rest.is_empty() {
                let Some(shaped) = self.shape(rest, window) else {
                    break;
                };
                if shaped.width() <= width {
                    rows.push(shaped);
                    break;
                }
                let hit = shaped.closest_byte_index_for_pixel_point(
                    point(width, Pixels::ZERO),
                    px(self.line_height),
                );
                let end = hit.unwrap_or_else(|i| i).min(rest.len());
                let mut end = rest[..end].rfind(char::is_whitespace).map_or(end, |i| {
                    i + rest[i..].chars().next().map_or(0, char::len_utf8)
                });
                // A visual break after '-' would appear to change the command.
                while end > 0 && rest[..end].ends_with('-') {
                    end -= 1;
                }
                if end == 0 {
                    end = rest.chars().next().map_or(rest.len(), char::len_utf8);
                }
                if let Some(row) = self.shape(&rest[..end], window) {
                    rows.push(row);
                }
                rest = &rest[end..];
            }
            if line.is_empty()
                && let Some(row) = self.shape("", window)
            {
                rows.push(row);
            }
        }
        rows
    }
}
impl Element for ExactAction {
    type RequestLayoutState = ();
    type PrepaintState = Vec<ShapedText>;
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
        _: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let action = self.clone();
        let id = window.request_measured_layout(style, move |known, available, window, _| {
            let width = known.width.unwrap_or_else(|| match available.width {
                AvailableSpace::Definite(w) => w,
                _ => px(480.),
            });
            size(
                width,
                px(action.rows(width, window).len() as f32 * action.line_height),
            )
        });
        (id, ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        _: &mut App,
    ) -> Vec<ShapedText> {
        self.rows(bounds.size.width, window)
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        rows: &mut Vec<ShapedText>,
        window: &mut Window,
        cx: &mut App,
    ) {
        for (i, row) in rows.iter().enumerate() {
            let origin = bounds.origin + point(Pixels::ZERO, px(i as f32 * self.line_height));
            let _ = row.paint(
                origin,
                px(self.line_height),
                TextAlign::Left,
                None,
                window,
                cx,
            );
        }
    }
}
