//! Linux software paint: CEF's `on_paint` BGRA buffer is copied into a CPU frame; the consumer
//! uploads the damaged area to a GPU texture.
use super::{OsrError, Rect, state::Page};
use std::{
    any::Any,
    cell::{Cell, Ref, RefCell},
    rc::Rc,
};

struct Soft {
    width: u32,
    height: u32,
    pixels: RefCell<Vec<u8>>,
    damage: Cell<Option<Rect>>,
    consumer: RefCell<Option<Box<dyn Any>>>,
}

#[derive(Clone)]
pub struct OsrFrame(Rc<Soft>);

impl OsrFrame {
    pub fn size(&self) -> (u32, u32) {
        (self.0.width, self.0.height)
    }
    pub fn get_width(&self) -> usize {
        self.0.width as usize
    }
    pub fn get_height(&self) -> usize {
        self.0.height as usize
    }
    /// The consumer's GPU copy of this frame (its texture). It lives and dies with the frame: a
    /// resized or hidden page drops it.
    pub fn consumer(&self) -> &RefCell<Option<Box<dyn Any>>> {
        &self.0.consumer
    }
    /// BGRA, premultiplied, rows top-down, stride `width * 4`. Never hold it across
    /// `OsrRuntime::pump`: CEF paints into this frame there.
    pub fn pixels(&self) -> Ref<'_, [u8]> {
        Ref::map(self.0.pixels.borrow(), Vec::as_slice)
    }
    /// The union of the areas painted since the last call; the consumer redraws when it is `Some`.
    pub fn take_damage(&self) -> Option<Rect> {
        self.0.damage.take()
    }
}

fn union(a: Option<Rect>, b: Rect) -> Rect {
    let Some(a) = a else {
        return b;
    };
    let (x, y) = (a.x.min(b.x), a.y.min(b.y));
    let right = (a.x + a.width).max(b.x + b.width);
    let bottom = (a.y + a.height).max(b.y + b.height);
    Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    }
}

/// `width` and `height` are positive; `buffer` holds `width * height * 4` bytes.
pub(super) fn paint(page: &mut Page, dirty: &[cef::Rect], buffer: &[u8], width: i32, height: i32) {
    let size = (width.unsigned_abs(), height.unsigned_abs());
    let Some(frame) = page.frame.as_ref().filter(|f| f.size() == size) else {
        page.frame = Some(OsrFrame(Rc::new(Soft {
            width: size.0,
            height: size.1,
            pixels: RefCell::new(buffer.to_vec()),
            damage: Cell::new(Some(Rect {
                x: 0,
                y: 0,
                width,
                height,
            })),
            consumer: RefCell::new(None),
        })));
        return;
    };
    let soft = &frame.0;
    let stride = size.0 as usize * 4;
    let mut pixels = soft.pixels.borrow_mut();
    for rect in dirty {
        let x0 = rect.x.clamp(0, width);
        let y0 = rect.y.clamp(0, height);
        let x1 = rect.x.saturating_add(rect.width).clamp(0, width);
        let y1 = rect.y.saturating_add(rect.height).clamp(0, height);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        // The clamps keep every coordinate inside the frame, so none is negative.
        let (from, to) = (
            x0.unsigned_abs() as usize * 4,
            x1.unsigned_abs() as usize * 4,
        );
        for row in y0.unsigned_abs() as usize..y1.unsigned_abs() as usize {
            let range = row * stride + from..row * stride + to;
            pixels[range.clone()].copy_from_slice(&buffer[range]);
        }
        let area = Rect {
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
        };
        soft.damage.set(Some(union(soft.damage.get(), area)));
    }
}

/// One BGRA pixel of a frame.
pub fn read_bgra_pixel(frame: &OsrFrame, x: usize, y: usize) -> Result<[u8; 4], OsrError> {
    let (width, height) = (frame.get_width(), frame.get_height());
    if x >= width || y >= height {
        return Err(OsrError("pixel outside the frame".into()));
    }
    let at = (y * width + x) * 4;
    frame
        .pixels()
        .get(at..at + 4)
        .and_then(|p| <[u8; 4]>::try_from(p).ok())
        .ok_or_else(|| OsrError("pixel outside the frame".into()))
}
