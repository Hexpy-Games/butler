//! Canonical design-system data with theme, material and accessibility overrides.
mod types;
pub use types::*;
mod generated;
pub use generated::*;

struct Table<K: 'static, V: 'static> {
    base: [&'static [V]; 4],
    compact: [&'static [(K, V)]; 4],
    density: [&'static [(K, V)]; 24],
    reduced: [&'static [(K, V)]; 24],
}

#[derive(Clone, Copy, Debug, Default)]
#[repr(usize)]
pub enum Density {
    Compact,
    #[default]
    Comfortable,
    Touch,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent CSS context axes, as specified by the token API"
)]
#[derive(Clone, Copy, Debug)]
pub struct TokenContext {
    pub dark: bool,
    pub sidebar_solid: bool,
    pub compact: bool,
    pub density: Density,
    pub reduced_motion: bool,
    pub ui_scale: f32,
    pub viewport: (f32, f32),
}

impl Default for TokenContext {
    fn default() -> Self {
        Self::DEFAULT
    }
}

// The enums are concrete at expansion, so all lookups are also usable in constants.
// Override entries remain in enum/CSS order and are searched logarithmically.
macro_rules! lookup {
    ($context:expr, $table:expr, $token:expr) => {{
        let context = $context;
        let table = &$table;
        let scope = context.dark as usize + 2 * context.sidebar_solid as usize;
        let override_index = scope * 6 + context.compact as usize * 3 + context.density as usize;
        let key = $token as usize;
        let layers = [
            if context.reduced_motion {
                table.reduced[override_index]
            } else {
                &[]
            },
            table.density[override_index],
            if context.compact {
                table.compact[scope]
            } else {
                &[]
            },
        ];
        let mut result = table.base[scope][key];
        let mut layer = layers.len();
        while layer > 0 {
            layer -= 1;
            let entries = layers[layer];
            let (mut lo, mut hi) = (0, entries.len());
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                if (entries[mid].0 as usize) < key {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            if lo < entries.len() && entries[lo].0 as usize == key {
                result = entries[lo].1;
            }
        }
        result
    }};
}

impl TokenContext {
    pub const DEFAULT: Self = Self {
        dark: false,
        sidebar_solid: false,
        compact: false,
        density: Density::Comfortable,
        reduced_motion: false,
        ui_scale: 1.,
        viewport: (0., 0.),
    };

    pub const fn try_color(&self, token: Color) -> Option<Rgba> {
        lookup!(self, generated::COLOR, token)
    }

    pub const fn color(&self, token: Color) -> Rgba {
        match self.try_color(token) {
            Some(value) => value,
            None => Rgba::TRANSPARENT,
        }
    }

    pub const fn try_len(&self, token: Length) -> Option<f32> {
        match lookup!(self, generated::LENGTH, token) {
            Some(value) => Some(value.resolve(self.ui_scale, self.viewport)),
            None => None,
        }
    }

    pub const fn len(&self, token: Length) -> f32 {
        match self.try_len(token) {
            Some(value) => value,
            None => 0.,
        }
    }

    pub const fn number(&self, token: Number) -> f32 {
        lookup!(self, generated::NUMBER, token)
    }
    pub const fn duration(&self, token: Duration) -> f32 {
        lookup!(self, generated::DURATION, token)
    }
    pub const fn ease(&self, token: Easing) -> Ease {
        lookup!(self, generated::EASING, token)
    }
    pub const fn shadow(&self, token: Shadow) -> &'static [ShadowLayer] {
        lookup!(self, generated::SHADOW, token)
    }
    pub const fn font(&self, token: FontStack) -> &'static [&'static str] {
        lookup!(self, generated::FONTSTACK, token)
    }
    pub const fn gradient(&self, token: GradientToken) -> Gradient {
        lookup!(self, generated::GRADIENTTOKEN, token)
    }
    pub const fn font_style(&self, token: FontStyle) -> FontShorthand {
        lookup!(self, generated::FONTSTYLE, token)
    }
    pub const fn edges(&self, token: Edges) -> [Len; 4] {
        lookup!(self, generated::EDGES, token)
    }
    pub const fn percent(&self, token: Percent) -> f32 {
        lookup!(self, generated::PERCENT, token)
    }
    pub const fn filter(&self, token: Filter) -> &'static [FilterOp] {
        lookup!(self, generated::FILTER, token)
    }
    pub const fn keyword(&self, token: KeywordToken) -> Keyword {
        lookup!(self, generated::KEYWORDTOKEN, token)
    }
}
