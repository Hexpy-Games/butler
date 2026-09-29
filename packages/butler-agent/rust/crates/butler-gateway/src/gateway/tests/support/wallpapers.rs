use super::*;

/// The fake gateway serves no wallpaper assets; the trait defaults reject.
impl GatewayWallpapers for TestApplication {}
