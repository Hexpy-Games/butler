//! CSS timing stops, including omitted-input interpolation.
use crate::{css::split, length::number};

pub(crate) fn emit(value: &str) -> Result<String, String> {
    if value == "linear" {
        return Ok("Ease::Linear(&[(0.0, 0.0), (1.0, 1.0)])".into());
    }
    if let Some(body) = value
        .strip_prefix("cubic-bezier(")
        .and_then(|s| s.strip_suffix(')'))
    {
        let values = split(body, ',')
            .into_iter()
            .map(|p| number(p.parse::<f64>().map_err(|e| e.to_string())?))
            .collect::<Result<Vec<_>, String>>()?;
        if values.len() != 4 {
            return Err("bezier needs four coordinates".into());
        }
        return Ok(format!("Ease::Bezier([{}])", values.join(", ")));
    }
    let body = value
        .strip_prefix("linear(")
        .and_then(|s| s.strip_suffix(')'))
        .ok_or("invalid easing")?;
    let mut points = Vec::new();
    for stop in split(body, ',') {
        let parts = split(stop, ' ');
        let output = parts[0].parse::<f64>().map_err(|e| e.to_string())?;
        if parts.len() > 3 {
            return Err("invalid linear stop".into());
        }
        if parts.len() == 1 {
            points.push((output, None));
        }
        for p in &parts[1..] {
            let input = p
                .strip_suffix('%')
                .ok_or("linear input requires percent")?
                .parse::<f64>()
                .map_err(|e| e.to_string())?
                / 100.;
            points.push((output, Some(input)));
        }
    }
    interpolate(&mut points)?;
    let code = points
        .into_iter()
        .map(|(y, x)| {
            Ok(format!(
                "({}, {})",
                number(y)?,
                number(x.ok_or("missing easing input")?)?
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!("Ease::Linear(&[{}])", code.join(", ")))
}

pub(crate) fn interpolate(points: &mut [(f64, Option<f64>)]) -> Result<(), String> {
    if points.len() < 2 {
        return Err("at least two stops required".into());
    }
    let last = points.len() - 1;
    points[0].1.get_or_insert(0.);
    points[last].1.get_or_insert(1.);
    let mut previous = f64::NEG_INFINITY;
    for (_, x) in points.iter_mut() {
        if let Some(x) = x {
            *x = x.max(previous);
            previous = *x;
        }
    }
    let mut start = 0;
    for end in 1..points.len() {
        if let Some(b) = points[end].1 {
            let a = points[start].1.ok_or("missing stop start")?;
            for (i, point) in points.iter_mut().enumerate().take(end).skip(start + 1) {
                point.1 = Some(a + (b - a) * (i - start) as f64 / (end - start) as f64);
            }
            start = end;
        }
    }
    Ok(())
}
