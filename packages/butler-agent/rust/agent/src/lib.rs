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
pub use host::{
    NativeConsolidationCliResult, NativeSkillCliResult, NativeWorkCliResult, ResolvedInstallation,
    native_automation_cli_recognizes, native_cognition_operator_cli_recognizes,
    native_context_cli_recognizes, native_conversation_recovery_cli_recognizes,
    native_doctor_cli_recognizes, native_gateway_cli_recognizes, native_mcp_cli_recognizes,
    native_observability_cli_recognizes, native_personalization_cli_recognizes,
    native_public_cli_recognizes, native_service_cli_recognizes, native_settings_cli_recognizes,
    native_status_cli_recognizes, native_transport_cli_recognizes, native_update_cli_recognizes,
    native_web_access_cli_recognizes, native_work_cli_recognizes, run_native_automation_cli,
    run_native_cognition_operator_cli, run_native_consolidation_cli, run_native_context_cli,
    run_native_conversation_recovery_cli, run_native_doctor_cli, run_native_gateway_cli,
    run_native_mcp_cli, run_native_memory_initialize_cli, run_native_memory_maintain_cli,
    run_native_memory_rebuild_cli, run_native_oauth_login, run_native_observability_cli,
    run_native_personalization_cli, run_native_public_cli, run_native_service,
    run_native_service_cli, run_native_settings_cli, run_native_skills_cli, run_native_status_cli,
    run_native_transport_cli, run_native_update_cli, run_native_web_access_cli,
    run_native_work_cli,
};

#[cfg(unix)]
pub use host::run_private_embedding_worker;
