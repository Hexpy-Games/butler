//! `butler-ds-view --shots <dir>`: renders every page headlessly through gpui's wgpu renderer
//! (the harness of `butler-shell-shots`) and writes `<page>.png` and `<page>.layout.json`
//! (the logical-pixel bounds of every story canvas, `story-<name>`). Motion is reduced, as in the
//! parity captures, so every frame is at rest.
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use butler_ds::ui::assets::Assets;
use butler_ds::ui::context::Ds;
use gpui::{AnyWindowHandle, AppContext as _, HeadlessAppContext, WindowHandle, px, size};

use crate::app::{self, DsView};
use crate::copy::Lang;

pub(crate) struct Options {
    pub(crate) dir: PathBuf,
    pub(crate) scale: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) dark: bool,
    pub(crate) lang: Lang,
    /// Grow the window to the page's full height.
    pub(crate) full: bool,
    /// Force every story canvas to this logical width.
    pub(crate) canvas_width: Option<f32>,
    /// Keep motion on (the default reduces it, so every frame is at rest).
    pub(crate) motion: bool,
    /// A real window this wide (logical px) with the viewer laid out for `width`: room for a
    /// layout scaled down into a story.
    pub(crate) stage_width: Option<f32>,
    /// Render only these page ids (`--pages a,b`); all pages when unset.
    pub(crate) pages: Option<Vec<String>>,
}

impl Options {
    /// `flag` names the output directory (`--shots` or `--live`).
    pub(crate) fn parse(args: &[std::ffi::OsString], flag: &str) -> anyhow::Result<Self> {
        let value = |flag: &str| {
            args.windows(2)
                .find(|pair| pair[0] == flag)
                .map(|pair| pair[1].to_str().context("arguments must be UTF-8"))
                .transpose()
        };
        let dir = value(flag)?.with_context(|| format!("{flag} requires <dir>"))?;
        let scale = value("--scale")?.unwrap_or("2").parse::<f32>()?;
        let (width, height) = value("--size")?
            .unwrap_or("1280x800")
            .split_once('x')
            .context("--size requires <W>x<H>")?;
        let (width, height) = (width.parse::<f32>()?, height.parse::<f32>()?);
        anyhow::ensure!(
            [scale, width, height]
                .iter()
                .all(|v| v.is_finite() && *v > 0.),
            "scale and dimensions must be finite and positive"
        );
        let lang = match value("--lang")? {
            None | Some("ko") => Lang::Ko,
            Some("en") => Lang::En,
            Some(_) => anyhow::bail!("--lang requires ko|en"),
        };
        Ok(Self {
            dir: PathBuf::from(dir),
            scale,
            width,
            height,
            dark: args.iter().any(|arg| arg == "--dark"),
            lang,
            full: args.iter().any(|arg| arg == "--full"),
            canvas_width: value("--canvas-width")?.map(str::parse).transpose()?,
            motion: args.iter().any(|arg| arg == "--motion"),
            stage_width: value("--stage-width")?.map(str::parse).transpose()?,
            pages: value("--pages")?.map(|ids| ids.split(',').map(str::to_owned).collect()),
        })
    }
}

pub(crate) fn context(options: &Options) -> anyhow::Result<HeadlessAppContext> {
    let platform = gpui_platform::current_platform(true);
    let mut cx =
        HeadlessAppContext::with_platform(platform.text_system(), Arc::new(Assets), || {
            gpui_wgpu::WgpuHeadlessRenderer::new()
                .ok()
                .map(|r| Box::new(r) as Box<dyn gpui::PlatformHeadlessRenderer>)
        });
    cx.set_window_scale_factor(options.scale);
    cx.update(|cx| {
        app::init(cx)?;
        app::install(cx, options.dark, options.lang);
        Ds::update(cx, |ds| ds.set_app_reduced_motion(!options.motion));
        if options
            .stage_width
            .is_some_and(|stage| stage > options.width)
        {
            cx.set_global(app::Stage(options.width));
        }
        if let Some(width) = options.canvas_width {
            cx.set_global(crate::pages::CanvasWidth(width));
        }
        Ok::<(), anyhow::Error>(())
    })?;
    Ok(cx)
}

pub(crate) fn settle(cx: &mut HeadlessAppContext, window: AnyWindowHandle) {
    for _ in 0..16 {
        cx.advance_clock(Duration::from_millis(50));
        cx.run_until_parked();
        let _ = cx.update_window(window, |_, window, _| window.refresh());
    }
    cx.run_until_parked();
}

pub(crate) fn open(
    cx: &mut HeadlessAppContext,
    options: &Options,
    height: f32,
    lang: Lang,
) -> anyhow::Result<(WindowHandle<DsView>, AnyWindowHandle)> {
    let window_width = options
        .stage_width
        .map_or(options.width, |stage| stage.max(options.width));
    let window = cx.open_window(size(px(window_width), px(height)), |window, cx| {
        cx.new(|cx| {
            let mut view = DsView::new(window, cx);
            view.lang = lang;
            view
        })
    })?;
    let handle: AnyWindowHandle = window.into();
    settle(cx, handle);
    Ok((window, handle))
}

pub(crate) fn story_anchors(
    cx: &mut HeadlessAppContext,
    window: WindowHandle<DsView>,
) -> Vec<String> {
    cx.update(|app| {
        window
            .read(app)
            .map(DsView::story_names)
            .unwrap_or_default()
    })
}

/// Saves the story canvas `bounds` (logical px) of `image` as `path`, rounded to device pixels.
pub(crate) fn crop(
    image: &image::RgbaImage,
    options: &Options,
    bounds: &gpui::Bounds<gpui::Pixels>,
    path: &Path,
) -> anyhow::Result<()> {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "nonnegative pixel coordinates inside the screenshot"
    )]
    let device = |value: gpui::Pixels| (value.as_f32() * options.scale).round() as u32;
    let (x, y) = (device(bounds.origin.x), device(bounds.origin.y));
    let (w, h) = (device(bounds.size.width), device(bounds.size.height));
    let w = w.min(image.width().saturating_sub(x));
    let h = h.min(image.height().saturating_sub(y));
    if w == 0 || h == 0 {
        println!("{}: empty story canvas, not cropped", path.display());
        return Ok(());
    }
    image::imageops::crop_imm(image, x, y, w, h)
        .to_image()
        .save(path)
        .with_context(|| format!("saving {}", path.display()))
}

/// The tallest window a page is rendered in (logical px): a readback buffer is at most 256 MiB, 13k device px of a 4800px stage.
const MAX_WINDOW_HEIGHT: f32 = 6400.;
/// Where a scrolled story's canvas is put under the window's top edge.
const SCROLL_MARGIN: f32 = 16.;

fn render_page(
    cx: &mut HeadlessAppContext,
    options: &Options,
    index: usize,
    id: &str,
) -> anyhow::Result<()> {
    let (mut window, mut handle) = open(cx, options, options.height, options.lang)?;
    cx.update(|app| window.update(app, |view, _, cx| view.open(index, cx)))?;
    settle(cx, handle);
    if options.full {
        let content = cx
            .debug_bounds(handle, "page-content")?
            .map_or(options.height, |b| b.size.height.as_f32());
        cx.update_window(handle, |_, window, _| window.remove_window())?;
        (window, handle) = open(
            cx,
            options,
            content.ceil().max(options.height).min(MAX_WINDOW_HEIGHT),
            options.lang,
        )?;
        cx.update(|app| window.update(app, |view, _, cx| view.open(index, cx)))?;
        settle(cx, handle);
    }
    let mut layout = Vec::new();
    let mut image = cx.capture_screenshot(handle)?;
    let window_height = cx.update_window(handle, |_, window, _| {
        window.viewport_size().height.as_f32()
    })?;
    for (index, name) in story_anchors(cx, window).into_iter().enumerate() {
        let anchor = format!("story-{name}");
        if let Some(b) = cx.debug_bounds(handle, &anchor)? {
            layout.push(
                serde_json::json!({"anchor": anchor, "x": b.origin.x.as_f32(),
                "y": b.origin.y.as_f32(), "w": b.size.width.as_f32(), "h": b.size.height.as_f32()}),
            );
            // A page taller than a texture scrolls: bring the canvas to the top, then crop it.
            let mut shown = b;
            if b.bottom().as_f32() > window_height {
                let top = b.origin.y.as_f32() - SCROLL_MARGIN;
                cx.update(|app| {
                    window.update(app, |view, _, _| {
                        view.scroll.set_offset(gpui::point(px(0.), px(-top)))
                    })
                })?;
                settle(cx, handle);
                image = cx.capture_screenshot(handle)?;
                shown = cx.debug_bounds(handle, &anchor)?.unwrap_or(b);
            }
            crop(
                &image,
                options,
                &shown,
                &options.dir.join(format!("{id}.{index}.png")),
            )?;
        }
    }
    let path = options.dir.join(format!("{id}.png"));
    image
        .save(&path)
        .with_context(|| format!("saving {}", path.display()))?;
    std::fs::write(
        options.dir.join(format!("{id}.layout.json")),
        serde_json::to_vec_pretty(&layout)?,
    )?;
    println!(
        "saved {} ({}x{})",
        path.display(),
        image.width(),
        image.height()
    );
    cx.update_window(handle, |_, window, _| window.remove_window())?;
    Ok(())
}

fn run(options: &Options) -> anyhow::Result<()> {
    std::fs::create_dir_all(&options.dir)
        .with_context(|| format!("creating {}", options.dir.display()))?;
    let mut cx = context(options)?;
    let pages: Vec<String> = crate::pages::all()
        .iter()
        .map(|page| page.id.to_owned())
        .collect();
    for (index, id) in pages.iter().enumerate() {
        if options.pages.as_ref().is_none_or(|only| only.contains(id)) {
            render_page(&mut cx, options, index, id)?;
        }
    }
    let _: &Path = &options.dir;
    Ok(())
}

pub(crate) fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().collect();
    match Options::parse(&args, "--shots").and_then(|options| run(&options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("butler-ds-view: {error:#}");
            ExitCode::FAILURE
        }
    }
}
