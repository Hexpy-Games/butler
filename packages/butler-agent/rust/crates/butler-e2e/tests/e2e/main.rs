#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test crate HTTP drivers"
)]
//! All current scenarios share one integration-test link.
mod acceptance_payload;
mod access;
mod access_tiers;
mod agent_context;
mod agent_exit;
mod agent_import;
mod alias_index_drop;
mod answer_blocks;
mod anthropic_cache;
mod anthropic_output_limit;
mod anthropic_requests;
mod anthropic_thinking_history;
mod app_admission_history;
mod app_db_schema;
mod app_retention;
mod app_state;
mod ask_user;
mod attachment_reach;
mod attachment_types;
mod authority_parallel_batch;
mod authority_permissions;
mod automation;
mod briefing_effort;
mod briefing_shutdown;
mod browse_executor;
mod browser_agent;
mod browser_approval;
mod browser_batch;
mod browser_delegation;
mod browser_downloads;
mod browser_headless;
mod browser_history;
mod browser_image_formats;
mod browser_journey;
mod browser_jspaint;
mod browser_library;
mod browser_long;
mod browser_naver;
mod browser_observation_v2;
mod browser_outputs;
mod browser_parallel;
mod browser_prefix;
mod browser_preview;
mod browser_round2;
mod browser_selection;
mod browser_signin;
mod browser_speed;
mod browser_still_busy;
mod browser_still_delivery;
mod browser_tab_claims;
mod browser_tool_args;
mod browser_usage;
mod browsing_settings;
mod cassette_lint;
mod catalog_provider_truth;
mod chatgpt_plan_usage;
mod chatgpt_session;
mod chatgpt_sign_in;
mod chatgpt_wire;
mod chats_replies;
mod cli_launcher;
mod cli_remote;
mod cli_reply_language;
mod cli_surface;
mod composer_decoration;
mod composer_fold;
mod connectors;
mod context_telemetry;
mod conversation_background;
mod credential_store;
mod credentials;
mod custom_model_errors;
mod custom_model_images;
mod default_model;
mod documents;
mod downloads_live;
mod durable_configuration;
mod durable_files;
mod embed_download;
mod error_library;
mod favicons;
mod feature_models;
mod full_reset;
mod gateway_browser;
#[path = "gateway_pairing.rs"]
mod gateway_pairing;
mod gateway_remote;
mod gateway_rotation;
mod gateway_security;
mod gateway_tunnel;
mod gemini_requests;
mod general_clear;
mod harness_hygiene;
mod hedge_v2_stub;
mod hooks;
mod idle_resources;
mod image_errors;
mod image_foundation;
mod image_limits;
mod image_only;
mod image_tools;
mod install_app;
mod install_hardening;
mod install_lifecycle;
mod install_safety;
mod install_support;
mod install_systemd;
mod install_versions;
mod installed_preview;
mod legacy_import;
mod lifecycle;
mod lifecycle_intent;
mod linux_sandbox;
mod live;
mod live_config;
mod local_zone;
mod long_paths;
mod mail;
mod mcp;
mod memory;
mod memory_existing;
#[path = "support/memory_fixture.rs"]
mod memory_fixture;
mod memory_hot_cache;
mod memory_idle;
mod memory_import;
mod memory_model_cleanup;
mod memory_wiring;
mod metric_retention;
mod migration;
mod model_thinking;
mod monitoring_history;
mod nfd_paths;
mod onboarding;
mod onboarding_form;
mod outbox_identity;
mod pending_asks;
mod perf_ask_user;
mod perf_turn;
mod personalization;
mod personalization_defaults;
mod plugins;
mod process_names;
mod project_git;
mod projection_backlog;
mod projection_settlement;
mod projects;
mod prompt_hedge;
mod prompt_history;
mod prompt_history_cache;
mod prompt_layout;
mod queue_admission_shutdown;
#[cfg(debug_assertions)]
mod queue_claim_crash;
mod queue_notifications;
mod queue_pause;
mod queue_send_now;
mod queue_shutdown;
mod quota;
mod quota_gating;
mod reader_tab;
mod recovery;
mod reduce_motion;
mod sandbox_installation;
mod schedule_calendar;
mod schedule_chat;
mod schedule_model;
mod schedule_sleep_wake;
mod schedule_store;
mod schedule_wake_catchup;
mod schedules;
mod search_browser;
mod security_oauth;
mod security_review;
mod service_diagnostics;
mod service_stop;
mod service_supervision;
mod session_branches;
mod session_reads;
mod settings;
mod setup_keys;
mod setup_local_models;
mod setup_oauth;
mod setup_onboarding;
mod setup_readiness;
mod shutdown_order;
mod shutdown_wal;
mod skills_disclosure;
mod startup_port;
mod startup_readiness;
mod steward_direction_failure;
mod steward_interrupted_queue;
mod steward_presentation;
mod steward_results;
mod stop_record_order;
mod storage_resilience;
mod stream_orders;
mod streaming;
mod subsession_legacy;
mod token_cache;
#[path = "support/token_metrics.rs"]
mod token_metrics;
mod tools;
mod tools_direct_args;
mod tools_effects;
mod turn;
mod turn_continuation;
mod turn_faults;
mod unadmitted_stop;
mod unicode_delivery;
mod update_channels;
mod update_discovery;
mod update_progress;
mod updates;
mod usage;
mod usage_history;
mod usage_timeline;
mod user_work;
mod wall_clock_budget;
mod wallpaper_writes;
mod wallpapers;
mod windows_commands;
mod windows_project_sandbox;
mod windows_sandbox;
mod windows_startup_xml;
mod workspace;

#[path = "memory/stubs.rs"]
mod memory_stubs;
#[path = "support/schedule_cassette.rs"]
mod schedule_cassette;

mod btcc_corrupt_startup;
mod btcc_cutover;
mod btcc_history;
mod btcc_startup_integrity;
mod cli_project_folder;
mod data_perf;
mod delegate_followup;
mod delegate_host_lost;
mod delegated_batching;
mod deliverables;
mod mac_app_update;
mod memory_consolidation;
mod memory_instructions;
mod memory_management;
mod memory_patterns;
mod memory_profile_reset;
mod memory_reset;
mod memory_wiring_more;
mod native_worker_ownership;
mod project_artifacts;
mod project_folder_browser;
mod project_instructions;
mod project_workspace;
mod schedule_handoff;
mod session_folder;
mod storage_concurrency;
mod supervisor_ownership;
#[path = "support/terminal_history.rs"]
mod terminal_history;
#[path = "support/transcript_history.rs"]
#[allow(clippy::unwrap_used, reason = "test fixture assertions")]
mod transcript_history;

#[path = "support/memory_reset_support.rs"]
mod memory_reset_support;

mod skills_cleanup;
mod storage_concurrency_support;

mod task_graphs;

mod acceptance_payload_perf;
mod storage_correction;

mod session_titles;
mod smart_groups;
#[path = "storage_correction/seed.rs"]
mod storage_correction_seed;

mod web_speed;

mod logs_request_completion;
mod structured_logs;

mod outbound_http;

mod trace_spans;

mod content_port;
mod turn_fenced_cancel;
mod usage_delegated;

mod work_model_api;
mod work_model_schema;

mod worker_cap;

mod canon_link;
mod canon_plan_run;
mod canon_registration;
mod one_call_delegation;

mod chats_initiated;
mod chats_proposals;
mod chats_work;

mod canon_criteria;
mod canon_mcp;
mod shell_client;
