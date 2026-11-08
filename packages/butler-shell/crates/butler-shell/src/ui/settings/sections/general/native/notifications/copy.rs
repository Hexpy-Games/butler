//! The copy of the notification permission section. Each field names its `packages/butler-i18n`
//! key.
use butler_ds::ui::context::Lang;

pub(super) struct NotificationCopy {
    /// settings.nativeNotifications.status.macosPermission, windowsShortcut, linuxLibnotify
    pub(super) details: [&'static str; 3],
    /// settings.nativeNotifications.settings.macos, windows, fallback
    pub(super) settings: [&'static str; 3],
    /// interfaceStatus.permissionCheck
    pub(super) permission_check: &'static str,
    /// interfaceStatus.test
    pub(super) test: &'static str,
    /// interfaceStatus.notificationSent
    pub(super) sent: &'static str,
    /// interfaceStatus.notificationHidden
    pub(super) hidden: &'static str,
    /// The test notification's title and body (`main.mjs` `butler:test-desktop-notification`).
    pub(super) test_message: [&'static str; 2],
}

const KO: NotificationCopy = NotificationCopy {
    details: [
        "macOS 알림 권한이 꺼져 있으면 시스템 설정에서 버틀러 알림을 허용해야 합니다.",
        "Windows 알림이 꺼져 있으면 시스템 알림 설정에서 버틀러 알림을 허용해야 합니다.",
        "Linux 알림은 데스크톱 환경과 libnotify 지원 여부에 따라 달라집니다.",
    ],
    settings: ["macOS 알림 설정", "Windows 알림 설정", "시스템 설정"],
    permission_check: "권한 상태 확인 필요",
    test: "테스트",
    sent: "테스트 알림을 보냈습니다.",
    hidden: "운영체제가 알림을 표시하지 않았습니다.",
    test_message: ["버틀러", "알림 테스트가 도착했습니다."],
};

const EN: NotificationCopy = NotificationCopy {
    details: [
        "If macOS notifications are disabled, allow Butler notifications in System Settings.",
        "If Windows notifications are disabled, allow Butler notifications in system notification settings.",
        "Linux notifications depend on the desktop environment and libnotify support.",
    ],
    settings: [
        "macOS notification settings",
        "Windows notification settings",
        "System settings",
    ],
    permission_check: "Check notification permissions",
    test: "Test",
    sent: "Test notification sent.",
    hidden: "The operating system did not show the notification.",
    test_message: ["Butler", "The test notification arrived."],
};

pub(super) fn words(lang: Lang) -> &'static NotificationCopy {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
