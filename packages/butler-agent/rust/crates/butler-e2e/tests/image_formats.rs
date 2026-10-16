//! Offline functional E2E of the gateway codec through a companion process.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::binary::fixture_binary;
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

const AVIF: &[u8] = include_bytes!("e2e/browser_headless/images/photo.avif");
const LARGE: &[u8] = include_bytes!("e2e/browser_headless/images/large.avif");
const SVG: &[u8] = include_bytes!("e2e/browser_headless/images/plain.svg");
const EXTERNAL: &str = include_str!("e2e/browser_headless/images/external.svg");

fn normalize(bytes: &[u8]) -> Output {
    let mut child = Command::new(fixture_binary("e2e-image-normalize").unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    child.wait_with_output().unwrap()
}

fn pixels(output: &Output, width: u32, height: u32) -> image::RgbImage {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= 250 * 1024);
    assert_eq!(
        image::guess_format(&output.stdout).unwrap(),
        image::ImageFormat::Jpeg
    );
    let image = image::load_from_memory(&output.stdout).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (width, height));
    image
}

#[test]
fn avif_and_svg_normalize_at_the_gateway_process_boundary()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let small = normalize(AVIF);
    assert!(
        small.status.success(),
        "{}",
        String::from_utf8_lossy(&small.stderr)
    );
    let image = image::load_from_memory(&small.stdout).unwrap();
    assert!(image.width() > 0 && image.height() > 0);
    assert!(image.width().max(image.height()) <= 1280);
    pixels(&small, image.width(), image.height());
    let large = normalize(LARGE);
    let image = pixels(&large, 1280, 960);
    assert!(image.get_pixel(100, 100)[0] < image.get_pixel(1100, 100)[0]);
    assert!(image.get_pixel(100, 100)[1] < image.get_pixel(100, 800)[1]);
    eprintln!("4000x3000 AVIF: {}", String::from_utf8_lossy(&large.stderr));
    let svg = normalize(SVG);
    let image = pixels(&svg, 1280, 960);
    assert!(image.get_pixel(100, 100)[2] > image.get_pixel(100, 100)[0]);
    assert!(image.get_pixel(1100, 100)[0] > image.get_pixel(1100, 100)[2]);
    Ok(())
}

#[test]
fn svg_external_resources_are_ignored_and_embedded_resources_work()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let temp = std::env::temp_dir().join(format!("butler-svg-external-{}", std::process::id()));
    std::fs::create_dir_all(&temp).unwrap();
    let file = temp.join("external.png");
    image::RgbImage::from_pixel(4, 4, image::Rgb([0, 0, 0]))
        .save(&file)
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let svg = EXTERNAL
        .replace("127.0.0.1:9", &listener.local_addr().unwrap().to_string())
        .replace(
            "file:///external.png",
            &format!("file://{}", file.display()),
        );
    let baseline = normalize(SVG);
    let external = normalize(svg.as_bytes());
    pixels(&external, 1280, 960);
    assert_eq!(
        baseline.stdout, external.stdout,
        "external images must not alter pixels"
    );
    assert!(
        listener.accept().is_err(),
        "renderer attempted a network request"
    );
    std::fs::remove_dir_all(temp).unwrap();
    let embedded = normalize(br#"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><image width="80" height="60" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='%23e03050'/%3E%3C/svg%3E"/></svg>"#);
    let image = pixels(&embedded, 80, 60);
    assert!(image.get_pixel(40, 30)[0] > 200);
    let text = normalize(r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="5" y="40" font-size="32">버틀러 Hello</text></svg>"#.as_bytes());
    let image = pixels(&text, 200, 60);
    assert!(
        image.pixels().any(|p| p[0] < 100),
        "bundled font must render text"
    );
    Ok(())
}

#[test]
fn malformed_and_oversized_sources_are_refused() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    for bytes in [
        b"not an image".as_slice(),
        &AVIF[..AVIF.len() / 2],
        br#"<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="1"/>"#,
        br#"<svg xmlns="http://www.w3.org/2000/svg" width="16000" height="16000"/>"#,
        br#"<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>"#,
    ] {
        assert!(!normalize(bytes).status.success());
    }
    let mut oversized = LARGE.to_vec();
    let ispe = oversized
        .windows(4)
        .position(|bytes| bytes == b"ispe")
        .unwrap();
    oversized[ispe + 8..ispe + 12].copy_from_slice(&20000u32.to_be_bytes());
    assert!(!normalize(&oversized).status.success());
    let mut nested =
        String::from(r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>"#);
    for _ in 0..10 {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(&nested);
        nested = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image width="8" height="8" href="data:image/svg+xml;base64,{data}"/></svg>"#
        );
    }
    assert!(!normalize(nested.as_bytes()).status.success());
    let deep = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60">{}<rect width="80" height="60"/>{}</svg>"#,
        "<g opacity='0.5'>".repeat(70),
        "</g>".repeat(70)
    );
    assert!(!normalize(deep.as_bytes()).status.success());
    let layers = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280">{}<rect width="1280" height="1280"/>{}</svg>"#,
        "<g opacity='0.5'><rect width='1280' height='1280'/>".repeat(10),
        "</g>".repeat(10)
    );
    assert!(!normalize(layers.as_bytes()).status.success());
    Ok(())
}
