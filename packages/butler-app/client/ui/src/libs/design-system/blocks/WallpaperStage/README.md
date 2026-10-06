# WallpaperStage

A full viewport base surface with a Wallpaper backdrop and a centered content layer. The content width leaves two `lg` token insets per side (296px at a 360px viewport).

The containing viewport supplies width and height. Use `desktopViewportScope` for narrow desktop windows, never for the main window. Children own copy, typography and actions.
