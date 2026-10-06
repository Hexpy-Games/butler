//! Capture only an explicitly identified App window for real-App acceptance.
use std::error::Error;
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let window_id: u32 = arguments.next().ok_or("provide a window ID")?.parse()?;
    let output = arguments.next().ok_or("provide an output PNG path")?;
    if arguments.next().is_some() {
        return Err("unexpected argument".into());
    }
    capture(window_id, Path::new(&output))
}

#[cfg(target_os = "macos")]
fn capture(window_id: u32, output: &Path) -> Result<(), Box<dyn Error>> {
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", "-l", &window_id.to_string()])
        .arg(output)
        .status()?;
    if !status.success() {
        return Err("App window capture failed".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn capture(_window_id: u32, _output: &Path) -> Result<(), Box<dyn Error>> {
    Err("this acceptance capture requires macOS".into())
}
