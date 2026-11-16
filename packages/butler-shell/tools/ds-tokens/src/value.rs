//! Typed, inert Rust initializers for all supported CSS value kinds.
use crate::{color, css::split, easing, length};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Color,
    Length,
    Number,
    Duration,
    Easing,
    Shadow,
    FontStack,
    FontStyle,
    GradientToken,
    Edges,
    Percent,
    Filter,
    Keyword,
}

impl Kind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Color => "Color",
            Self::Length => "Length",
            Self::Number => "Number",
            Self::Duration => "Duration",
            Self::Easing => "Easing",
            Self::Shadow => "Shadow",
            Self::FontStack => "FontStack",
            Self::FontStyle => "FontStyle",
            Self::GradientToken => "GradientToken",
            Self::Edges => "Edges",
            Self::Percent => "Percent",
            Self::Filter => "Filter",
            Self::Keyword => "KeywordToken",
        }
    }
    pub(crate) fn value_type(self) -> &'static str {
        match self {
            Self::Color => "Rgba",
            Self::Length => "Len",
            Self::Number | Self::Duration | Self::Percent => "f32",
            Self::Easing => "Ease",
            Self::Shadow => "&'static [ShadowLayer]",
            Self::FontStack => "&'static [&'static str]",
            Self::FontStyle => "FontShorthand",
            Self::GradientToken => "Gradient",
            Self::Edges => "[Len; 4]",
            Self::Filter => "&'static [FilterOp]",
            Self::Keyword => "Keyword",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Value {
    pub kind: Kind,
    pub code: String,
}

pub(crate) fn parse(text: &str) -> Result<Value, String> {
    let v = text.trim();
    let (kind, code) = if v == "infinite" {
        (Kind::Number, "f32::INFINITY".into())
    } else if v == "linear" || v.starts_with("linear(") || v.starts_with("cubic-bezier(") {
        (Kind::Easing, easing::emit(v)?)
    } else if identifier(v) && !matches!(v, "initial" | "transparent" | "infinite") {
        (Kind::Keyword, format!("Keyword({v:?})"))
    } else if v.starts_with("linear-gradient(") {
        (Kind::GradientToken, gradient(v)?)
    } else if v.starts_with('#')
        || v.starts_with("rgb")
        || v.starts_with("color-mix(")
        || v == "transparent"
    {
        (Kind::Color, color::parse(v)?.emit()?)
    } else if let Some(n) = v.strip_suffix("ms") {
        (
            Kind::Duration,
            length::number(n.trim().parse::<f64>().map_err(|e| e.to_string())?)?,
        )
    } else if let Some(n) = v.strip_suffix('s').filter(|n| n.parse::<f64>().is_ok()) {
        (
            Kind::Duration,
            length::number(n.parse::<f64>().map_err(|e| e.to_string())? * 1000.)?,
        )
    } else if let Some(n) = v.strip_suffix('%').filter(|n| n.parse::<f64>().is_ok()) {
        (
            Kind::Percent,
            length::number(n.parse::<f64>().map_err(|e| e.to_string())? / 100.)?,
        )
    } else if v.starts_with(['"', '\'']) || v.contains(',') && !v.contains('(') {
        (Kind::FontStack, fonts(v)?)
    } else if ["blur(", "saturate(", "brightness(", "contrast(", "opacity("]
        .iter()
        .any(|p| v.starts_with(p))
    {
        (Kind::Filter, filters(v)?)
    } else if v.contains("rgb") || v.contains('#') {
        (Kind::Shadow, shadow(v)?)
    } else if let Ok(n) = v.parse::<f64>() {
        (Kind::Number, length::number(n)?)
    } else if let Ok(ops) = length::parse(v) {
        (Kind::Length, length::emit(&ops)?)
    } else {
        (Kind::Edges, edges(v)?)
    };
    Ok(Value { kind, code })
}

fn identifier(v: &str) -> bool {
    v.starts_with(|c: char| c.is_ascii_lowercase())
        && v.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

fn fonts(value: &str) -> Result<String, String> {
    let names = split(value, ',')
        .into_iter()
        .map(|name| {
            let name = name.trim_matches(['\'', '"']);
            if name.is_empty() || name.contains(['(', ')', '/']) {
                return Err(format!("invalid font family {name}"));
            }
            Ok(format!("{name:?}"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!("&[{}]", names.join(", ")))
}

fn edges(value: &str) -> Result<String, String> {
    let parts = split(value, ' ');
    if !(2..=4).contains(&parts.len()) {
        return Err(format!("unsupported value {value}"));
    }
    let lengths = parts
        .iter()
        .map(|p| length::emit(&length::parse(p)?))
        .collect::<Result<Vec<_>, String>>()?;
    let indices = match lengths.len() {
        2 => [0, 1, 0, 1],
        3 => [0, 1, 2, 1],
        _ => [0, 1, 2, 3],
    };
    Ok(format!(
        "[{}]",
        indices.map(|i| lengths[i].clone()).join(", ")
    ))
}

fn filters(value: &str) -> Result<String, String> {
    let ops = split(value, ' ')
        .into_iter()
        .map(|p| {
            let (name, arg) = p.split_once('(').ok_or("invalid filter")?;
            let arg = arg.strip_suffix(')').ok_or("unclosed filter")?;
            if name == "blur" {
                return Ok(format!(
                    "FilterOp::Blur({})",
                    length::emit(&length::parse(arg)?)?
                ));
            }
            let n = if let Some(percent) = arg.strip_suffix('%') {
                percent.parse::<f64>().map_err(|e| e.to_string())? / 100.
            } else {
                arg.parse::<f64>().map_err(|e| e.to_string())?
            };
            let name = match name {
                "saturate" => "Saturate",
                "brightness" => "Brightness",
                "contrast" => "Contrast",
                "opacity" => "Opacity",
                _ => return Err(format!("unsupported filter {name}")),
            };
            Ok(format!("FilterOp::{name}({})", length::number(n)?))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!("&[{}]", ops.join(", ")))
}

fn shadow(value: &str) -> Result<String, String> {
    let layers = split(value, ',').into_iter().map(|layer| {
        let mut parts = split(layer, ' ');
        let inset = parts.contains(&"inset");
        parts.retain(|p| *p != "inset");
        let color = color::parse(parts.pop().ok_or("shadow requires colour")?)?.emit()?;
        if !(3..=4).contains(&parts.len()) { return Err("shadow requires x y blur [spread]".into()); }
        let mut lens = parts.iter().map(|p| length::emit(&length::parse(p)?)).collect::<Result<Vec<_>, String>>()?;
        if lens.len() == 3 { lens.push("Len::Px(0.0)".into()); }
        Ok(format!("ShadowLayer {{ x: {}, y: {}, blur: {}, spread: {}, color: {color}, inset: {inset} }}", lens[0], lens[1], lens[2], lens[3]))
    }).collect::<Result<Vec<_>, String>>()?;
    Ok(format!("&[{}]", layers.join(", ")))
}

fn gradient(value: &str) -> Result<String, String> {
    let body = value
        .strip_prefix("linear-gradient(")
        .and_then(|s| s.strip_suffix(')'))
        .ok_or("invalid gradient")?;
    let parts = split(body, ',');
    let angle = parts
        .first()
        .and_then(|s| s.strip_suffix("deg"))
        .ok_or("gradient requires degree angle")?
        .parse::<f64>()
        .map_err(|e| e.to_string())?;
    let mut colors = Vec::new();
    let mut positions = Vec::new();
    for p in &parts[1..] {
        let pieces = split(p, ' ');
        colors.push(color::parse(pieces[0])?.emit()?);
        let x = pieces
            .get(1)
            .map(|p| {
                p.strip_suffix('%')
                    .ok_or("gradient stop requires percent")?
                    .parse::<f64>()
                    .map(|v| v / 100.)
                    .map_err(|e| e.to_string())
            })
            .transpose()?;
        positions.push((0., x));
    }
    easing::interpolate(&mut positions)?;
    let stops = colors
        .into_iter()
        .zip(positions)
        .map(|(c, (_, p))| {
            Ok(format!(
                "({c}, {})",
                length::number(p.ok_or("missing stop")?)?
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!(
        "Gradient {{ angle_deg: {}, stops: &[{}] }}",
        length::number(angle)?,
        stops.join(", ")
    ))
}
