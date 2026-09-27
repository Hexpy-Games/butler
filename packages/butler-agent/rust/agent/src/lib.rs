/// Declares a domain's closed set of wire error codes.
///
/// Each variant maps one-to-one to the snake_case string that is persisted in
/// journals and receipts and sent over IPC, the gateway and tool results. The
/// strings are the wire contract: `as_str` is the only way a code reaches the
/// wire, and every domain pins its table with a `wire_codes_are_stable` test.
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

pub(crate) mod btcc;
mod capabilities;
mod cognition;
mod configuration;
mod context;
mod conversation;
mod coordination;
pub(crate) mod gateway;

mod js_date;
mod json;
mod json_lines;
mod locale;
mod mcp_client;
mod models;
mod operations;
mod profile;
mod project_ledger;
mod segmentation;
mod skills;
#[cfg(test)]
mod testing;
mod tool_protocol;

mod host;
mod public_text;
mod web_access;
mod work_records;
mod workspace;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
