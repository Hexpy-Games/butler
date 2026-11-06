//! The blocks of the design system (DS `blocks/`): the app shell, its sidebar and title row, the
//! conversation frame, the panels that sit in them, and the navigation and row blocks.
//! Window-level facts (the window size, the platform, fullscreen) come in as inputs, so the app
//! wires them in one place.
pub mod adaptive_shell;
pub mod anim;
pub mod collapsible_nav_group;
pub mod conversation_shell;
pub mod drag_preview;
pub mod inspector_panel;
pub mod measure;
pub mod nav_drop;
pub mod nav_row;
pub mod nav_section;
pub mod overflow_action_menu;
pub mod panel_header;
pub mod responsive;
pub mod scope;
pub mod sidebar_shell;
pub mod surface_panel;
pub mod titlebar_shell;
pub mod wallpaper_stage;
