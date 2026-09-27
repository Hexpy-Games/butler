//! Leaf building blocks shared by every Butler crate.
//!
//! Nothing here knows about sessions, memory or providers: JSON and JSONL
//! codecs with ECMAScript semantics ([`json`], [`json_lines`]), JS date and
//! locale mirrors ([`js_date`], [`locale`]), text segmentation and public-text
//! sanitizing, the agent configuration file ([`configuration`]), the model-facing
//! tool protocol and [`tool_protocol::ToolName`], and the `wire_codes!` macro
//! every domain uses to declare its closed set of wire error codes.

/// Declares a domain's closed set of wire error codes.
///
/// Each variant maps one-to-one to the snake_case string that is persisted in
/// journals and receipts and sent over IPC, the gateway and tool results. The
/// strings are the wire contract: `as_str` is the only way a code reaches the
/// wire, and every domain pins its table with a `wire_codes_are_stable` test.
#[macro_export]
macro_rules! wire_codes {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $($variant:ident = $wire:literal,)+
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[allow(
            clippy::enum_variant_names,
            reason = "variant names are derived from the wire codes they spell"
        )]
        $vis enum $name {
            $(
                #[doc = concat!("Wire code `", $wire, "`.")]
                $variant,
            )+
        }

        impl $name {
            /// Every code in declaration order.
            #[cfg(test)]
            $vis const ALL: &'static [Self] = &[$(Self::$variant,)+];

            /// The persisted and wire spelling of this code.
            $vis const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

pub mod configuration;
pub mod js_date;
pub mod json;
pub mod json_lines;
pub mod locale;
pub mod public_text;
pub mod segmentation;
pub mod tool_protocol;
