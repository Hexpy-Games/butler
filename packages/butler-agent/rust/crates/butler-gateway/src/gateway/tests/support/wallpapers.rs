use super::*;

/// The fake gateway serves no wallpaper assets; the trait defaults reject.
impl GatewayWallpapers for TestApplication {}

/// The fake gateway keeps no sign-ins; the trait default rejects.
impl crate::gateway::GatewaySignIns for TestApplication {}
