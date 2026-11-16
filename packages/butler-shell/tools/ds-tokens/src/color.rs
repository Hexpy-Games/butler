//! CSS sRGB colours, including premultiplied colour mixing.
use crate::css::split;
use crate::length::number;

#[derive(Clone, Copy)]
pub(crate) struct Color(pub [f64; 4]);

pub(crate) fn parse(text: &str) -> Result<Color, String> {
    let text = text.trim();
    if text == "transparent" {
        return Ok(Color([0.; 4]));
    }
    if let Some(hex) = text.strip_prefix('#') {
        if hex.len() != 6 {
            return Err(format!("unsupported hex colour {text}"));
        }
        let mut c = [0., 0., 0., 1.];
        for (i, value) in c.iter_mut().take(3).enumerate() {
            *value = f64::from(
                u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?,
            ) / 255.;
        }
        return Ok(Color(c));
    }
    if let Some(body) = text
        .strip_prefix("color-mix(")
        .and_then(|s| s.strip_suffix(')'))
    {
        return mix(body);
    }
    for prefix in ["rgb(", "rgba("] {
        if let Some(body) = text.strip_prefix(prefix).and_then(|s| s.strip_suffix(')')) {
            if let Some(body) = body.trim().strip_prefix("from ") {
                return relative(body);
            }
            let parts = split(body, ',');
            if parts.len() != 3 && parts.len() != 4 {
                return Err(format!("invalid rgb colour {text}"));
            }
            let mut values = [0., 0., 0., 1.];
            for (i, p) in parts.iter().enumerate() {
                values[i] = if let Some(p) = p.strip_suffix('%') {
                    numeric(p)? / 100.
                } else {
                    numeric(p)? / if i < 3 { 255. } else { 1. }
                };
                values[i] = values[i].clamp(0., 1.);
            }
            return Ok(Color(values));
        }
    }
    Err(format!("unsupported colour {text}"))
}

fn relative(body: &str) -> Result<Color, String> {
    let parts = split(body, ' ');
    if parts.len() != 6 || parts[1..5] != ["r", "g", "b", "/"] {
        return Err(format!("unsupported relative colour {body}"));
    }
    let mut c = parse(parts[0])?;
    c.0[3] = numeric(parts[5])?.clamp(0., 1.);
    Ok(c)
}

fn numeric(text: &str) -> Result<f64, String> {
    text.trim().parse::<f64>().map_err(|e| e.to_string())
}

fn weighted(text: &str) -> Result<(Color, Option<f64>), String> {
    let parts = split(text, ' ');
    if let Some(percent) = parts.last().and_then(|p| p.strip_suffix('%')) {
        let end = text
            .rfind(parts[parts.len() - 1])
            .ok_or("missing mix weight")?;
        Ok((parse(text[..end].trim())?, Some(numeric(percent)? / 100.)))
    } else {
        Ok((parse(text)?, None))
    }
}

fn mix(body: &str) -> Result<Color, String> {
    let parts = split(body, ',');
    if parts.len() != 3 || parts[0] != "in srgb" {
        return Err("only sRGB colour mixing is supported".into());
    }
    let (a, pa) = weighted(parts[1])?;
    let (b, pb) = weighted(parts[2])?;
    let pa = pa.unwrap_or_else(|| pb.map_or(0.5, |p| 1. - p));
    let pb = pb.unwrap_or(1. - pa);
    let total = pa + pb;
    if pa < 0. || pb < 0. || total <= 0. {
        return Err("invalid colour mix weights".into());
    }
    let (pa, pb) = (pa / total, pb / total);
    let alpha = a.0[3] * pa + b.0[3] * pb;
    let mut c = [0.; 4];
    if alpha > 0. {
        for (i, value) in c.iter_mut().take(3).enumerate() {
            *value = (a.0[i] * a.0[3] * pa + b.0[i] * b.0[3] * pb) / alpha;
        }
    }
    c[3] = alpha * total.min(1.);
    Ok(Color(c))
}

impl Color {
    pub(crate) fn emit(self) -> Result<String, String> {
        Ok(format!(
            "Rgba {{ r: {}, g: {}, b: {}, a: {} }}",
            number(self.0[0])?,
            number(self.0[1])?,
            number(self.0[2])?,
            number(self.0[3])?
        ))
    }
}
