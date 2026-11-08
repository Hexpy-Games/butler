//! The tray mark as pixels: the PNG decoded once and averaged down to the size an OS draws.
use std::io::Cursor;

use super::TrayError;

/// Straight-alpha RGBA8 pixels, row by row.
pub(super) struct Rgba {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) data: Vec<u8>,
}

fn failed(error: impl std::fmt::Display) -> TrayError {
    TrayError::Failed(format!("decode tray icon: {error}"))
}

/// Decodes a PNG of any colour type and depth to RGBA8.
pub(super) fn decode(png: &[u8]) -> Result<Rgba, TrayError> {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(failed)?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(failed)?;
    let channels = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale | png::ColorType::Indexed => 1,
    };
    let pixels = buffer
        .get(..info.buffer_size())
        .ok_or_else(|| failed("short image"))?;
    let data = pixels
        .chunks_exact(channels)
        .flat_map(|pixel| match pixel {
            [r, g, b, a] => [*r, *g, *b, *a],
            [r, g, b] => [*r, *g, *b, u8::MAX],
            [gray, a] if channels == 2 => [*gray, *gray, *gray, *a],
            [gray, ..] => [*gray, *gray, *gray, u8::MAX],
            [] => [0; 4],
        })
        .collect();
    Ok(Rgba {
        width: info.width,
        height: info.height,
        data,
    })
}

/// The mean of `pixels` (colour weighted by alpha, so transparent edges leave no halo).
fn mean(pixels: impl Iterator<Item = [u8; 4]>) -> [u8; 4] {
    let (mut color, mut alpha, mut count) = ([0_u64; 3], 0_u64, 0_u64);
    for [r, g, b, a] in pixels {
        let a = u64::from(a);
        color = [
            color[0] + u64::from(r) * a,
            color[1] + u64::from(g) * a,
            color[2] + u64::from(b) * a,
        ];
        alpha += a;
        count += 1;
    }
    let channel = |sum: u64| u8::try_from(sum.checked_div(alpha).unwrap_or(0)).unwrap_or(u8::MAX);
    let [r, g, b] = color.map(channel);
    [
        r,
        g,
        b,
        u8::try_from(alpha.checked_div(count).unwrap_or(0)).unwrap_or(u8::MAX),
    ]
}

/// Averages the image into `side` x `side` pixels (a box filter: every source pixel counts).
pub(super) fn square(source: &Rgba, side: u32) -> Rgba {
    let (sw, sh, side) = (source.width as usize, source.height as usize, side as usize);
    let span = |index: usize, total: usize| {
        let start = index * total / side;
        (
            start,
            ((index + 1) * total / side).max(start + 1).min(total),
        )
    };
    let mut data = Vec::with_capacity(side * side * 4);
    for ty in 0..side {
        let (y0, y1) = span(ty, sh);
        for tx in 0..side {
            let (x0, x1) = span(tx, sw);
            let pixels = (y0..y1).flat_map(|y| {
                let row = source
                    .data
                    .get((y * sw + x0) * 4..(y * sw + x1) * 4)
                    .unwrap_or(&[]);
                row.as_chunks::<4>().0.iter().copied()
            });
            data.extend(mean(pixels));
        }
    }
    let side = u32::try_from(side).unwrap_or(0);
    Rgba {
        width: side,
        height: side,
        data,
    }
}
