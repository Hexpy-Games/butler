//! Rendering-independent token value types.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const TRANSPARENT: Self = Self {
        r: 0.,
        g: 0.,
        b: 0.,
        a: 0.,
    };
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Len {
    Px(f32),
    Scaled(f32),
    Expr(&'static [Op]),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Op {
    Px(f32),
    Vw(f32),
    Vh(f32),
    Number(f32),
    Add,
    Sub,
    Mul,
    Div,
    Min,
    Max,
    Clamp,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ease {
    Bezier([f32; 4]),
    Linear(&'static [(f32, f32)]),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowLayer {
    pub x: Len,
    pub y: Len,
    pub blur: Len,
    pub spread: Len,
    pub color: Rgba,
    pub inset: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gradient {
    pub angle_deg: f32,
    pub stops: &'static [(Rgba, f32)],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FilterOp {
    Blur(Len),
    Saturate(f32),
    Brightness(f32),
    Contrast(f32),
    Opacity(f32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keyword(pub &'static str);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontShorthand {
    pub size: super::Length,
    pub line_height: super::Length,
    pub weight: Option<super::Number>,
    pub family: super::FontStack,
}

impl Len {
    pub const fn resolve(self, ui_scale: f32, viewport: (f32, f32)) -> f32 {
        match self {
            Self::Px(n) => n,
            Self::Scaled(n) => n / ui_scale,
            Self::Expr(ops) => evaluate(ops, &mut ops.len(), viewport),
        }
    }
}

/// Consume RPN from the end; recursion needs no heap allocation or fixed stack limit.
const fn evaluate(ops: &[Op], end: &mut usize, viewport: (f32, f32)) -> f32 {
    *end -= 1;
    match ops[*end] {
        Op::Px(n) | Op::Number(n) => n,
        Op::Vw(n) => n * viewport.0 / 100.,
        Op::Vh(n) => n * viewport.1 / 100.,
        Op::Add => {
            let b = evaluate(ops, end, viewport);
            evaluate(ops, end, viewport) + b
        }
        Op::Sub => {
            let b = evaluate(ops, end, viewport);
            evaluate(ops, end, viewport) - b
        }
        Op::Mul => {
            let b = evaluate(ops, end, viewport);
            evaluate(ops, end, viewport) * b
        }
        Op::Div => {
            let b = evaluate(ops, end, viewport);
            evaluate(ops, end, viewport) / b
        }
        Op::Min => {
            let b = evaluate(ops, end, viewport);
            let a = evaluate(ops, end, viewport);
            if a < b { a } else { b }
        }
        Op::Max => {
            let b = evaluate(ops, end, viewport);
            let a = evaluate(ops, end, viewport);
            if a > b { a } else { b }
        }
        Op::Clamp => {
            let hi = evaluate(ops, end, viewport);
            let value = evaluate(ops, end, viewport);
            let lo = evaluate(ops, end, viewport);
            let value = if value < hi { value } else { hi };
            if value > lo { value } else { lo }
        }
    }
}
