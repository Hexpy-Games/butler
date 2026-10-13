//! Offline process boundary for the gateway's image codec and measurement.
use std::{
    io::{Read, Write},
    time::Instant,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    let started = Instant::now();
    let image = butler_runtime::browser::normalize_image(&input)?;
    eprintln!(
        "normalize_ms={} width={} height={} bytes={}",
        started.elapsed().as_millis(),
        image.width,
        image.height,
        image.bytes.len()
    );
    std::io::stdout().write_all(&image.bytes)?;
    Ok(())
}
