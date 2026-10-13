//! Bound XML complexity and render-layer scratch before rasterization.
use resvg::usvg;

pub(super) fn input(bytes: &[u8]) -> Result<(), &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid_image")?;
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: 100_000,
    };
    let document =
        roxmltree::Document::parse_with_options(text, options).map_err(|_| "invalid_image")?;
    if document
        .descendants()
        .any(|node| node.ancestors().take(65).count() > 64)
    {
        return Err("invalid_image");
    }
    Ok(())
}

pub(super) fn layers(tree: &usvg::Tree, scale: f32) -> Result<(), &'static str> {
    let mut pending = vec![(tree.root(), 0)];
    let mut count = 0;
    let mut scratch = 0.0;
    while let Some((group, depth)) = pending.pop() {
        count += group.children().len() + 1;
        if depth > 64 || count > 100_000 {
            return Err("invalid_image");
        }
        let resources = resources(group, depth, &mut pending)?;
        if group.should_isolate() {
            let bounds = group.abs_layer_bounding_box();
            let width = (f64::from(bounds.width()) * f64::from(scale)).ceil() + 4.0;
            let height = (f64::from(bounds.height()) * f64::from(scale)).ceil() + 4.0;
            // Account for retained filter results as well as working RGBA/alpha planes.
            let primitives: usize = group.filters().iter().map(|f| f.primitives().len()).sum();
            let buffers = u32::try_from(primitives)
                .map_err(|_| "invalid_image")?
                .checked_add(8 + resources * 2)
                .ok_or("invalid_image")?;
            scratch += width * height * 4.0 * f64::from(buffers);
            if !scratch.is_finite() || scratch > 128.0 * 1024.0 * 1024.0 {
                return Err("invalid_image");
            }
        }
        for node in group.children() {
            if let usvg::Node::Group(child) = node {
                pending.push((child, depth + 1));
            }
        }
    }
    Ok(())
}

fn resources<'a>(
    group: &'a usvg::Group,
    depth: usize,
    pending: &mut Vec<(&'a usvg::Group, usize)>,
) -> Result<u32, &'static str> {
    let mut count = 0;
    for (index, mask) in std::iter::successors(group.mask(), |mask| mask.mask())
        .take(65)
        .enumerate()
    {
        if depth + index + 1 > 64 {
            return Err("invalid_image");
        }
        pending.push((mask.root(), depth + index + 1));
        count += 1;
    }
    for (index, clip) in std::iter::successors(group.clip_path(), |clip| clip.clip_path())
        .take(65)
        .enumerate()
    {
        if depth + index + 1 > 64 {
            return Err("invalid_image");
        }
        pending.push((clip.root(), depth + index + 1));
        count += 1;
    }
    Ok(count)
}
