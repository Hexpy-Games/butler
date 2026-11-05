//! Review-only pixel differences; differences never fail the command.
use std::{collections::BTreeSet, path::Path};

use image::{ImageReader, Rgba, RgbaImage};

fn names(dir: &Path) -> anyhow::Result<BTreeSet<std::ffi::OsString>> {
    let mut names = BTreeSet::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.path().extension().is_some_and(|e| e == "png") {
            names.insert(entry.file_name());
        }
    }
    Ok(names)
}

fn image_result<T>(result: image::ImageResult<T>, path: &Path) -> anyhow::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(image::ImageError::IoError(error)) => Err(error.into()),
        Err(error) => {
            println!("{}: {error}", path.display());
            Ok(None)
        }
    }
}

fn load(path: &Path) -> anyhow::Result<Option<RgbaImage>> {
    Ok(image_result(ImageReader::open(path)?.decode(), path)?.map(|image| image.to_rgba8()))
}

fn heat(a: &RgbaImage, b: &RgbaImage) -> (RgbaImage, u64) {
    let mut differing = 0;
    let result = RgbaImage::from_fn(b.width(), b.height(), |x, y| {
        let p = b.get_pixel(x, y);
        let changed = a.get_pixel(x, y) != p;
        differing += u64::from(changed);
        let overlay = if changed {
            [255, 0, 255]
        } else {
            [128, 128, 128]
        };
        let weight = if changed { 60 } else { 30 };
        let mut out = [0; 4];
        for i in 0..3 {
            let mixed = (u32::from(p[i]) * (100 - weight) + overlay[i] * weight) / 100;
            out[i] = u8::try_from(mixed).unwrap_or(255);
        }
        out[3] = p[3];
        Rgba(out)
    });
    (result, differing)
}

fn run(a: &Path, b: &Path, out: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(out)?;
    let (left, right) = (names(a)?, names(b)?);
    for name in left.union(&right) {
        let label = name.to_string_lossy();
        if !left.contains(name) || !right.contains(name) {
            println!(
                "{label} missing in {}",
                if left.contains(name) { "B" } else { "A" }
            );
            continue;
        }
        let (Some(a), Some(b)) = (load(&a.join(name))?, load(&b.join(name))?) else {
            continue;
        };
        if a.dimensions() != b.dimensions() {
            println!(
                "{label} size mismatch {:?} {:?}",
                a.dimensions(),
                b.dimensions()
            );
            continue;
        }
        let (image, differing) = heat(&a, &b);
        let mut heat_name = Path::new(name).with_extension("heat.png");
        heat_name = out.join(heat_name);
        image_result(image.save(&heat_name), &heat_name)?;
        println!(
            "{label} {differing}/{}",
            u64::from(a.width()) * u64::from(a.height())
        );
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        eprintln!("usage: parity-diff <dirA> <dirB> <outDir>");
        return Ok(());
    }
    run(
        Path::new(&args[0]),
        Path::new(&args[1]),
        Path::new(&args[2]),
    )
}
