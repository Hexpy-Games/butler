//! `ImageEditorToolbar.tsx`: brush, eraser, brush size, undo and hold-to-compare.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::mask_canvas::MaskTool;
use butler_ds::ui::button::{self, Button, Variant};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::popover::{Popover, PopoverContent};
use butler_ds::ui::slider::Slider;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, KeyDownEvent, KeyUpEvent,
    MouseButton, ParentElement as _, Window, div,
};

use super::ImageEditor;
use crate::ui::images::copy::Words;

impl ImageEditor {
    pub(super) fn toolbar(
        &self,
        copy: &Words,
        strokes: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locked = self.locked();
        let tool = |id: &'static str,
                    label: &'static str,
                    glyph: Icon,
                    tool: MaskTool,
                    cx: &mut Context<Self>| {
            let mut button = IconButton::new(id, label)
                .glyph(glyph)
                .pressed(self.tool == tool);
            if self.tool == tool {
                button = button.selected();
            }
            if locked {
                button = button.disabled();
            }
            button.on_click(cx.listener(move |this, _, _, cx| {
                this.tool = tool;
                cx.notify();
            }))
        };
        let brush = tool(
            "image-editor-brush",
            copy.brush,
            Icon::Brush,
            MaskTool::Brush,
            cx,
        );
        let eraser = tool(
            "image-editor-eraser",
            copy.eraser,
            Icon::Eraser,
            MaskTool::Eraser,
            cx,
        );
        let size = self.size_control(copy, window, cx);
        let mut undo = IconButton::new("image-editor-undo", copy.undo).glyph(Icon::Undo);
        if strokes == 0 || locked {
            undo = undo.disabled();
        } else {
            undo = undo.on_click(cx.listener(|this, _, _, cx| this.undo(cx)));
        }
        button::container(button::Size::Sm)
            .child(brush)
            .child(eraser)
            .child(size)
            .child(undo)
            .child(self.compare_button(copy, cx))
            .into_any_element()
    }

    /// The brush size slider in a popover.
    fn size_control(
        &self,
        copy: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let popover = Popover::new("image-editor-size", window, cx);
        let locked = self.locked();
        let trigger = popover.trigger(|toggle| {
            let mut trigger = Button::new("image-editor-size-trigger")
                .variant(Variant::Ghost)
                .size(button::Size::Sm)
                .text(copy.brush_size);
            if locked {
                trigger = trigger.disabled();
            }
            trigger.on_click(toggle.on_click()).into_any_element()
        });
        let this = cx.entity().downgrade();
        let slider = Slider::new("image-editor-size-slider", f64::from(self.size), 4., 160.)
            .step(4.)
            .on_value_change(move |value, _, cx| {
                let _ = this.update(cx, |this, cx| {
                    #[expect(clippy::cast_possible_truncation, reason = "a brush size of 4 to 160")]
                    let size = value as f32;
                    this.size = size.clamp(4., 160.);
                    cx.notify();
                });
            });
        let content = popover.content(PopoverContent::new().child(slider), window, cx);
        div().child(trigger).child(content).into_any_element()
    }

    /// Held, it shows the original (pointer, Space or Enter); released or blurred, it stops.
    fn compare_button(&self, copy: &Words, cx: &mut Context<Self>) -> AnyElement {
        let mut hold = Button::new("image-editor-compare")
            .variant(Variant::Ghost)
            .size(button::Size::Sm)
            .text(copy.original);
        if self.locked() {
            hold = hold.disabled();
        }
        let hold_key = |key: &str| key == "space" || key == "enter";
        div()
            .id("image-editor-compare-hold")
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.set_compare(true, cx)),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.set_compare(false, cx)),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| this.set_compare(false, cx)),
            )
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if hold_key(&event.keystroke.key) {
                    this.set_compare(true, cx);
                }
            }))
            .on_key_up(cx.listener(move |this, event: &KeyUpEvent, _, cx| {
                if hold_key(&event.keystroke.key) {
                    this.set_compare(false, cx);
                }
            }))
            .child(
                Tooltip::new("image-editor-compare-tip")
                    .label(copy.compare)
                    .child(hold),
            )
            .into_any_element()
    }
}
