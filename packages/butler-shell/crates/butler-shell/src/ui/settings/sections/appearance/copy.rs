//! The copy of Appearance (`appCopy.settings`). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// settings.pageSections.theme
    pub(crate) section_theme: &'static str,
    /// settings.pageSections.homeScreen
    pub(crate) section_home_screen: &'static str,
    /// settings.pageSections.conversation
    pub(crate) section_conversation: &'static str,
    /// settings.pageSections.messageBox
    pub(crate) section_message_box: &'static str,
    /// settings.pageSections.accessibility
    pub(crate) section_accessibility: &'static str,
    /// settings.pageSectionDescriptions.homeScreen
    pub(crate) home_screen_description: &'static str,
    /// settings.pageSectionDescriptions.conversation
    pub(crate) conversation_description: &'static str,
    /// settings.pageSectionDescriptions.messageBox
    pub(crate) message_box_description: &'static str,
    /// settings.fields.theme
    pub(crate) theme: &'static str,
    /// settings.options.system
    pub(crate) system: &'static str,
    /// settings.options.light
    pub(crate) light: &'static str,
    /// settings.options.dark
    pub(crate) dark: &'static str,
    /// settings.fields.textSize
    pub(crate) text_size: &'static str,
    /// settings.options.textSizeDefault
    pub(crate) text_size_default: &'static str,
    /// settings.options.textSizeLarge
    pub(crate) text_size_large: &'static str,
    /// settings.options.textSizeLarger
    pub(crate) text_size_larger: &'static str,
    /// settings.fields.translucentSidebar
    pub(crate) translucent_sidebar: &'static str,
    /// settings.fields.wallpaperMotion
    pub(crate) wallpaper_motion: &'static str,
    /// settings.descriptions.wallpaperMotion
    pub(crate) wallpaper_motion_description: &'static str,
    /// settings.descriptions.wallpaperStill
    pub(crate) wallpaper_still: &'static str,
    /// settings.fields.wallpaperPauseOnBattery
    pub(crate) pause_on_battery: &'static str,
    /// settings.descriptions.wallpaperPauseOnBattery
    pub(crate) pause_on_battery_description: &'static str,
    /// settings.fields.showThinking
    pub(crate) show_thinking: &'static str,
    /// settings.fields.conversationBackground
    pub(crate) conversation_background: &'static str,
    /// settings.fields.conversationOverlay
    pub(crate) conversation_overlay: &'static str,
    /// settings.fields.collapseMessageBox
    pub(crate) collapse_message_box: &'static str,
    /// settings.descriptions.collapseMessageBox
    pub(crate) collapse_message_box_description: &'static str,
    /// settings.fields.composerDecoration
    pub(crate) composer_decoration: &'static str,
    /// settings.descriptions.composerDecoration
    pub(crate) composer_decoration_description: &'static str,
    /// settings.wallpaper.none
    pub(crate) none: &'static str,
    /// ComposerDecorationSettings.tsx: the locale-conditional option labels
    pub(crate) shoreline: &'static str,
    pub(crate) cherry: &'static str,
    /// settings.fields.composerCharacter
    pub(crate) composer_character: &'static str,
    /// settings.descriptions.composerCharacter
    pub(crate) composer_character_description: &'static str,
    /// settings.fields.reduceMotion
    pub(crate) reduce_motion: &'static str,
    /// settings.descriptions.reduceMotion
    pub(crate) reduce_motion_description: &'static str,
}

const KO: Words = Words {
    section_theme: "테마",
    section_home_screen: "홈 화면",
    section_conversation: "대화창",
    section_message_box: "입력창",
    section_accessibility: "접근성",
    home_screen_description: "새 채팅 첫 화면의 배경입니다.",
    conversation_description: "대화 화면의 배경과 표시입니다.",
    message_box_description: "새 채팅과 대화 화면의 입력창에 함께 적용됩니다.",
    theme: "테마",
    system: "시스템",
    light: "라이트",
    dark: "다크",
    text_size: "글자 크기",
    text_size_default: "기본",
    text_size_large: "크게",
    text_size_larger: "아주 크게",
    translucent_sidebar: "투명 사이드바",
    wallpaper_motion: "움직임",
    wallpaper_motion_description: "배경을 천천히 움직입니다.",
    wallpaper_still: "동작 줄이기가 켜져 있어 멈춰 있습니다",
    pause_on_battery: "배터리 사용 시 멈춤",
    pause_on_battery_description: "전원이 연결되지 않으면 멈춥니다.",
    show_thinking: "생각 내용 표시",
    conversation_background: "대화창 배경",
    conversation_overlay: "배경 불투명도",
    collapse_message_box: "입력창 접기",
    collapse_message_box_description: "입력하지 않을 때 입력창을 한 줄로 줄입니다.",
    composer_decoration: "입력창 배경",
    composer_decoration_description: "글자 뒤에 그림을 깝니다.",
    none: "없음",
    shoreline: "해안선",
    cherry: "벚꽃",
    composer_character: "캐릭터",
    composer_character_description: "입력창 위에 작은 친구가 앉습니다.",
    reduce_motion: "동작 줄이기",
    reduce_motion_description: "끄면 시스템 설정을 따릅니다.",
};

const EN: Words = Words {
    section_theme: "Theme",
    section_home_screen: "Home screen",
    section_conversation: "Conversation",
    section_message_box: "Message box",
    section_accessibility: "Accessibility",
    home_screen_description: "The background of the new chat screen.",
    conversation_description: "Background and display for conversations.",
    message_box_description: "Applies to the input on new chats and conversation screens.",
    theme: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
    text_size: "Text size",
    text_size_default: "Default",
    text_size_large: "Large",
    text_size_larger: "Larger",
    translucent_sidebar: "Translucent sidebar",
    wallpaper_motion: "Motion",
    wallpaper_motion_description: "Animate the background.",
    wallpaper_still: "Paused by Reduce motion",
    pause_on_battery: "Pause on battery",
    pause_on_battery_description: "Hold still when unplugged.",
    show_thinking: "Show thinking",
    conversation_background: "Conversation background",
    conversation_overlay: "Overlay",
    collapse_message_box: "Collapse message box",
    collapse_message_box_description: "Shrink the message box to one line when you're not typing.",
    composer_decoration: "Message box background",
    composer_decoration_description: "Art behind your text.",
    none: "None",
    shoreline: "Shoreline",
    cherry: "Cherry blossom",
    composer_character: "Character",
    composer_character_description: "A little friend sits above the message box.",
    reduce_motion: "Reduce motion",
    reduce_motion_description: "When off, follows your system setting.",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
