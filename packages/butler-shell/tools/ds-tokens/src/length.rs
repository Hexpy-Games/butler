//! Length arithmetic; generation folds constants and preserves viewport expressions.
use crate::css::{closing, split};

#[derive(Clone, Debug)]
pub(crate) enum Op {
    Px(f64),
    Vw(f64),
    Vh(f64),
    Number(f64),
    Scale,
    Add,
    Sub,
    Mul,
    Div,
    Min,
    Max,
    Clamp,
}

pub(crate) fn parse(text: &str) -> Result<Vec<Op>, String> {
    let mut parser = Parser { text, pos: 0 };
    let ops = parser.expression(0)?;
    parser.space();
    if parser.pos != text.len() {
        return Err(format!("invalid length {text}"));
    }
    Ok(ops)
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while self.text[self.pos..].starts_with(char::is_whitespace) {
            self.pos += 1;
        }
    }

    fn expression(&mut self, min_priority: u8) -> Result<Vec<Op>, String> {
        let mut left = self.atom()?;
        loop {
            self.space();
            let Some(op) = self.text[self.pos..].chars().next() else {
                break;
            };
            let priority = match op {
                '+' | '-' => 1,
                '*' | '/' => 2,
                _ => break,
            };
            if priority < min_priority {
                break;
            }
            self.pos += 1;
            left.extend(self.expression(priority + 1)?);
            left.push(match op {
                '+' => Op::Add,
                '-' => Op::Sub,
                '*' => Op::Mul,
                _ => Op::Div,
            });
        }
        Ok(left)
    }

    fn atom(&mut self) -> Result<Vec<Op>, String> {
        self.space();
        let rest = &self.text[self.pos..];
        if rest.starts_with("var(--ui-scale)") {
            self.pos += "var(--ui-scale)".len();
            return Ok(vec![Op::Scale]);
        }
        if rest.starts_with('(') || rest.starts_with(char::is_alphabetic) {
            return self.function();
        }
        let start = self.pos;
        if rest.starts_with(['-', '+']) {
            self.pos += 1;
        }
        while self.text[self.pos..].starts_with(|c: char| c.is_ascii_digit() || c == '.') {
            self.pos += 1;
        }
        let n: f64 = self.text[start..self.pos]
            .parse()
            .map_err(|_| format!("invalid number in {}", self.text))?;
        let start = self.pos;
        while self.text[self.pos..].starts_with(char::is_alphabetic) {
            self.pos += 1;
        }
        Ok(vec![match &self.text[start..self.pos] {
            "px" => Op::Px(n),
            "rem" => Op::Px(n * 16.),
            "vw" => Op::Vw(n),
            "vh" => Op::Vh(n),
            "" => Op::Number(n),
            unit => return Err(format!("unsupported length unit {unit}")),
        }])
    }

    fn function(&mut self) -> Result<Vec<Op>, String> {
        let rest = &self.text[self.pos..];
        let open = rest
            .find('(')
            .ok_or_else(|| format!("invalid length {rest}"))?;
        let end = closing(rest, open, '(', ')')?;
        let name = rest[..open].trim();
        let body = &rest[open + 1..end];
        self.pos += end + 1;
        match name {
            "" | "calc" => parse(body),
            "env" => parse(split(body, ',').get(1).ok_or("env requires fallback")?),
            "min" | "max" => {
                let mut ops = Vec::new();
                for (i, value) in split(body, ',').into_iter().enumerate() {
                    ops.extend(parse(value)?);
                    if i > 0 {
                        ops.push(if name == "min" { Op::Min } else { Op::Max });
                    }
                }
                if ops.is_empty() {
                    return Err("empty min/max".into());
                }
                Ok(ops)
            }
            "clamp" => {
                let parts = split(body, ',');
                if parts.len() != 3 {
                    return Err("clamp needs three arguments".into());
                }
                let mut ops = Vec::new();
                for part in parts {
                    ops.extend(parse(part)?);
                }
                ops.push(Op::Clamp);
                Ok(ops)
            }
            _ => Err(format!("unsupported length function {name}")),
        }
    }
}

pub(crate) fn evaluate(ops: &[Op]) -> Result<f64, String> {
    let mut stack: Vec<f64> = Vec::new();
    for op in ops {
        match op {
            Op::Px(n) | Op::Number(n) => stack.push(*n),
            Op::Vw(_) | Op::Vh(_) | Op::Scale => return Err("dynamic dependency".into()),
            _ => {
                let b = stack.pop().ok_or("missing operand")?;
                let a = stack.pop().ok_or("missing operand")?;
                let value = match op {
                    Op::Add => a + b,
                    Op::Sub => a - b,
                    Op::Mul => a * b,
                    Op::Div => a / b,
                    Op::Min => a.min(b),
                    Op::Max => a.max(b),
                    Op::Clamp => stack.pop().ok_or("missing clamp operand")?.max(a.min(b)),
                    _ => return Err("invalid operation".into()),
                };
                if !value.is_finite() {
                    return Err("non-finite arithmetic result".into());
                }
                stack.push(value);
            }
        }
    }
    if stack.len() != 1 {
        return Err("invalid length expression".into());
    }
    stack.pop().ok_or("empty expression".into())
}

pub(crate) fn emit(ops: &[Op]) -> Result<String, String> {
    let scales = ops.iter().filter(|op| matches!(op, Op::Scale)).count();
    if scales > 0 {
        if scales == 1
            && matches!(ops.last(), Some(Op::Div))
            && matches!(ops.get(ops.len() - 2), Some(Op::Scale))
        {
            return Ok(format!(
                "Len::Scaled({})",
                number(evaluate(&ops[..ops.len() - 2])?)?
            ));
        }
        return Err("UI scale must divide a constant length".into());
    }
    if !ops.iter().any(|op| matches!(op, Op::Vw(_) | Op::Vh(_))) {
        return Ok(format!("Len::Px({})", number(evaluate(ops)?)?));
    }
    let values = ops
        .iter()
        .map(|op| match op {
            Op::Px(n) => Ok(format!("Op::Px({})", number(*n)?)),
            Op::Number(n) => Ok(format!("Op::Number({})", number(*n)?)),
            Op::Vw(n) => Ok(format!("Op::Vw({})", number(*n)?)),
            Op::Vh(n) => Ok(format!("Op::Vh({})", number(*n)?)),
            other => Ok(format!("Op::{other:?}")),
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!("Len::Expr(&[{}])", values.join(", ")))
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "the runtime token format is f32"
)]
pub(crate) fn number(n: f64) -> Result<String, String> {
    if !n.is_finite() || !(n as f32).is_finite() {
        return Err("non-finite arithmetic result".into());
    }
    let literal = format!("{:?}", n as f32);
    let exponent = literal.find(['e', 'E']).unwrap_or(literal.len());
    let (mantissa, exponent) = literal.split_at(exponent);
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, "0"));
    let whole = whole
        .chars()
        .enumerate()
        .map(|(i, c)| {
            if i > 0
                && whole.as_bytes()[i - 1].is_ascii_digit()
                && c.is_ascii_digit()
                && (whole.len() - i).is_multiple_of(3)
            {
                format!("_{c}")
            } else {
                c.to_string()
            }
        })
        .collect::<String>();
    let fraction = fraction
        .chars()
        .enumerate()
        .map(|(i, c)| {
            if i > 0 && i.is_multiple_of(3) {
                format!("_{c}")
            } else {
                c.to_string()
            }
        })
        .collect::<String>();
    Ok(format!("{whole}.{fraction}{exponent}"))
}
