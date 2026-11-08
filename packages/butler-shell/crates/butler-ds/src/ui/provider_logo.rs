//! DS ProviderLogo (ProviderLogo.tsx, providerLogoSvgs.ts, app/setupProviders.ts
//! `providerLogoName`): a service logo (ChatGPT, Claude, Ollama, ...) drawn from the vendored SVG
//! files, never recoloured or stretched, framed on the icon-pack grid. Monochrome logos paint
//! with the text colour (`--text-primary`); colour logos keep their own fills. The files in
//! `assets/provider-logos/` carry the React `fit` viewBox (see their NOTICE); `ASSETS` serves
//! them next to the DS icons.
use gpui::{
    App, InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, RenderOnce,
    SharedString, Styled as _, StyledImage as _, Window, div, img, svg,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

macro_rules! logo {
    ($name:literal) => {
        (
            concat!("provider-logos/", $name, ".svg"),
            include_bytes!(concat!("../../assets/provider-logos/", $name, ".svg")).as_slice(),
        )
    };
}

/// The vendored logo files, served by `assets::Assets` next to the DS icons.
pub(crate) const ASSETS: &[(&str, &[u8])] = &[
    logo!("openai"),
    logo!("claude"),
    logo!("anthropic"),
    logo!("gemini"),
    logo!("grok"),
    logo!("qwen"),
    logo!("kimi"),
    logo!("zai"),
    logo!("deepseek"),
    logo!("upstage"),
    logo!("opencode"),
    logo!("ollama"),
    logo!("lmstudio"),
];

/// Every vendored logo, in display order (`PROVIDER_LOGO_NAMES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderLogoName {
    OpenAi,
    Claude,
    Anthropic,
    Gemini,
    Grok,
    Qwen,
    Kimi,
    Zai,
    DeepSeek,
    Upstage,
    OpenCode,
    Ollama,
    LmStudio,
}

impl ProviderLogoName {
    pub const ALL: [Self; 13] = [
        Self::OpenAi,
        Self::Claude,
        Self::Anthropic,
        Self::Gemini,
        Self::Grok,
        Self::Qwen,
        Self::Kimi,
        Self::Zai,
        Self::DeepSeek,
        Self::Upstage,
        Self::OpenCode,
        Self::Ollama,
        Self::LmStudio,
    ];

    /// The file name, as the React `PROVIDER_LOGO_SVGS` key.
    pub fn key(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Claude => "claude",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Grok => "grok",
            Self::Qwen => "qwen",
            Self::Kimi => "kimi",
            Self::Zai => "zai",
            Self::DeepSeek => "deepseek",
            Self::Upstage => "upstage",
            Self::OpenCode => "opencode",
            Self::Ollama => "ollama",
            Self::LmStudio => "lmstudio",
        }
    }

    /// `tone: "mono"`: the drawing follows the text colour.
    pub fn is_mono(self) -> bool {
        !matches!(
            self,
            Self::Claude
                | Self::Anthropic
                | Self::Gemini
                | Self::Qwen
                | Self::DeepSeek
                | Self::Upstage
        )
    }
}

/// The DS logo of a catalog provider (a local server by its platform), or none. `beside_name`:
/// next to the provider's own name ("Anthropic"), not one of its models ("Claude ...").
pub fn provider_logo_name(
    provider_id: &str,
    platform: Option<&str>,
    beside_provider_name: bool,
) -> Option<ProviderLogoName> {
    use ProviderLogoName::{
        Anthropic, Claude, DeepSeek, Gemini, Grok, Kimi, LmStudio, Ollama, OpenAi, OpenCode, Qwen,
        Upstage, Zai,
    };
    if provider_id == "local" {
        return match platform {
            Some("ollama") => Some(Ollama),
            Some("lm_studio") => Some(LmStudio),
            _ => None,
        };
    }
    if beside_provider_name && provider_id == "anthropic" {
        return Some(Anthropic);
    }
    Some(match provider_id {
        "openai" => OpenAi,
        "anthropic" => Claude,
        "google" => Gemini,
        "xai" => Grok,
        "qwen" => Qwen,
        "kimi" => Kimi,
        "zai" | "zai-api" => Zai,
        "deepseek" => DeepSeek,
        "upstage" => Upstage,
        "opencode-go" => OpenCode,
        _ => return None,
    })
}

/// `sm` 14px, `md` 16px (default), `lg` 20px: the icon size scale.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProviderLogoSize {
    Sm,
    #[default]
    Md,
    Lg,
}

#[derive(IntoElement)]
pub struct ProviderLogo {
    name: ProviderLogoName,
    size: ProviderLogoSize,
    label: Option<SharedString>,
}

impl ProviderLogo {
    pub fn new(name: ProviderLogoName) -> Self {
        Self {
            name,
            size: ProviderLogoSize::Md,
            label: None,
        }
    }

    pub fn size(mut self, size: ProviderLogoSize) -> Self {
        self.size = size;
        self
    }

    /// The accessible name; leave it off when a visible label names the service. gpui has no
    /// accessibility tree yet, so it only names the element for the screenshot harness.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
}

impl RenderOnce for ProviderLogo {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let side = ds.len(match self.size {
            ProviderLogoSize::Sm => Length::IconSizeSm,
            ProviderLogoSize::Md => Length::IconSizeMd,
            ProviderLogoSize::Lg => Length::IconSizeLg,
        });
        let path = SharedString::from(format!("provider-logos/{}.svg", self.name.key()));
        // gpui paints an svg as a mask in one colour; a colour logo is drawn as an image.
        let mark = if self.name.is_mono() {
            svg()
                .path(path)
                .size(side)
                .flex_none()
                .text_color(ds.color(Color::TextPrimary))
                .into_any_element()
        } else {
            img(path)
                .size(side)
                .object_fit(ObjectFit::Contain)
                .into_any_element()
        };
        let mut root = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(side);
        if let Some(label) = self.label {
            root = root.debug_selector(move || label.to_string());
        }
        root.child(mark)
    }
}
