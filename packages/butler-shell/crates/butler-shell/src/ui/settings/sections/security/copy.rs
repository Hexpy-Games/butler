//! The copy of the Security page (`appCopy.settings.security`, `settings.pageSections.remoteAccess`
//! and `settings.errors.updateSettings`). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.pageSections.remoteAccess
    pub(super) remote_access_title: &'static str,
    /// settings.errors.updateSettings
    pub(super) update_failed: &'static str,
    /// settings.security.remoteAccess
    pub(super) remote_access: &'static str,
    /// settings.security.remoteAccessDescription
    pub(super) remote_access_description: &'static str,
    /// settings.security.addresses
    pub(super) addresses: &'static str,
    /// settings.security.noAddresses
    pub(super) no_addresses: &'static str,
    /// settings.security.bindErrors: address_in_use, permission_denied, address_unavailable,
    /// bind_failed
    bind_errors: [&'static str; 4],
    /// settings.security.copyAddress
    pub(super) copy_address: &'static str,
    /// settings.security.copied
    pub(super) copied: &'static str,
    /// settings.security.code
    pub(super) code: &'static str,
    /// settings.security.pairDevice
    pub(super) pair_device: &'static str,
    /// settings.security.expiresIn
    pub(super) expires_in: fn(u64) -> String,
    /// settings.security.invalidated
    pub(super) invalidated: &'static str,
    /// settings.security.paired
    pub(super) paired: &'static str,
    /// settings.security.pairingFailed
    pub(super) pairing_failed: &'static str,
    /// settings.security.working
    pub(super) working: &'static str,
    /// settings.security.devices
    pub(super) devices: &'static str,
    /// settings.security.noDevices
    pub(super) no_devices: &'static str,
    /// settings.security.revoke
    pub(super) revoke: &'static str,
    /// settings.security.revokeDevice
    pub(super) revoke_device: fn(&str) -> String,
    /// settings.security.revokeAll
    pub(super) revoke_all: &'static str,
    /// settings.security.revokeAllTitle
    pub(super) revoke_all_title: &'static str,
    /// settings.security.revokeAllConfirm
    pub(super) revoke_all_confirm: &'static str,
    /// settings.security.revokeFailed
    pub(super) revoke_failed: &'static str,
    /// settings.security.adminRequired
    pub(super) admin_required: &'static str,
    /// settings.security.advanced
    pub(super) advanced: &'static str,
    /// settings.security.advancedContents
    pub(super) advanced_contents: &'static str,
    /// settings.security.hosts
    pub(super) hosts: &'static str,
    /// settings.security.hostsDescription
    pub(super) hosts_description: &'static str,
    /// settings.security.hostPlaceholder
    pub(super) host_placeholder: &'static str,
    /// settings.security.contentHosts
    pub(super) content_hosts: &'static str,
    /// settings.security.contentHostsDescription
    pub(super) content_hosts_description: &'static str,
    /// settings.security.contentHostPlaceholder
    pub(super) content_host_placeholder: &'static str,
    /// settings.security.hostCount
    pub(super) host_count: fn(usize) -> String,
    /// settings.security.addHost
    pub(super) add_host: &'static str,
    /// settings.security.removeHost
    pub(super) remove_host: fn(&str) -> String,
    /// settings.security.invalidHost
    pub(super) invalid_host: &'static str,
    /// `Intl.RelativeTimeFormat` (numeric auto) of the last-seen time: this minute
    pub(super) just_now: &'static str,
    /// minutes ago
    pub(super) minutes_ago: fn(u64) -> String,
    /// hours ago
    pub(super) hours_ago: fn(u64) -> String,
    /// yesterday
    pub(super) yesterday: &'static str,
    /// days ago
    pub(super) days_ago: fn(u64) -> String,
}

impl Words {
    /// The copy of the first stable `bind_errors` code it knows; none known is `bind_failed`.
    pub(super) fn bind_error<'a>(&self, mut codes: impl Iterator<Item = &'a str>) -> &'static str {
        let [in_use, denied, unavailable, failed] = self.bind_errors;
        codes
            .find_map(|code| match code {
                "address_in_use" => Some(in_use),
                "permission_denied" => Some(denied),
                "address_unavailable" => Some(unavailable),
                _ => None,
            })
            .unwrap_or(failed)
    }
}

static KO: Words = Words {
    remote_access_title: "원격 접속",
    update_failed: "설정 업데이트 실패",
    remote_access: "다른 컴퓨터에서 접속 허용",
    remote_access_description: "같은 네트워크의 기기에서 연결 코드를 입력해 접속합니다.",
    addresses: "접속 주소",
    no_addresses: "네트워크 주소 없음",
    bind_errors: [
        "포트 사용 중",
        "포트 권한 없음",
        "주소 사용 불가",
        "주소 열기 실패",
    ],
    copy_address: "주소 복사",
    copied: "복사됨",
    code: "코드",
    pair_device: "기기 연결",
    expires_in: |seconds| format!("{seconds}초 남음"),
    invalidated: "실패가 반복돼 새 코드를 발급했어요",
    paired: "기기를 연결했어요",
    pairing_failed: "연결 코드를 발급하지 못했어요",
    working: "처리 중이에요",
    devices: "연결된 기기",
    no_devices: "연결된 기기 없음",
    revoke: "연결 끊기",
    revoke_device: |name| format!("{name} 연결 끊기"),
    revoke_all: "모두 끊기",
    revoke_all_title: "모든 기기의 연결을 끊을까요?",
    revoke_all_confirm: "연결된 모든 기기의 접속 권한을 해제합니다.",
    revoke_failed: "기기 연결을 끊지 못했어요",
    admin_required: "버틀러 앱을 확인하지 못했습니다.",
    advanced: "고급",
    advanced_contents: "터널·프록시용 허용 호스트",
    hosts: "호스트 이름",
    hosts_description: "터널이나 프록시가 쓰는 이름입니다.",
    host_placeholder: "butler.example.com",
    content_hosts: "결과물 호스트",
    content_hosts_description: "결과물을 원격에서 열 때 쓰는 터널 이름입니다.",
    content_host_placeholder: "content.example.com",
    host_count: |count| match count {
        0 => "없음".to_owned(),
        n => format!("{n}개"),
    },
    add_host: "추가",
    remove_host: |host| format!("{host} 삭제"),
    invalid_host: "호스트 이름이나 IP를 입력하세요",
    just_now: "지금",
    minutes_ago: |n| format!("{n}분 전"),
    hours_ago: |n| format!("{n}시간 전"),
    yesterday: "어제",
    days_ago: |n| format!("{n}일 전"),
};

static EN: Words = Words {
    remote_access_title: "Remote access",
    update_failed: "Failed to update settings",
    remote_access: "Allow access from other computers",
    remote_access_description: "Devices on your network enter the connection code to connect.",
    addresses: "Addresses",
    no_addresses: "No network address",
    bind_errors: [
        "Port in use",
        "Port blocked",
        "Address unavailable",
        "Couldn't open address",
    ],
    copy_address: "Copy address",
    copied: "Copied",
    code: "Code",
    pair_device: "Pair device",
    expires_in: |seconds| format!("{seconds}s remaining"),
    invalidated: "Repeated failures issued a new code",
    paired: "Device paired",
    pairing_failed: "Could not issue a pairing code",
    working: "Working…",
    devices: "Paired devices",
    no_devices: "No paired devices",
    revoke: "Disconnect",
    revoke_device: |name| format!("Disconnect {name}"),
    revoke_all: "Disconnect all",
    revoke_all_title: "Disconnect all devices?",
    revoke_all_confirm: "Revoke access for every paired device.",
    revoke_failed: "Could not disconnect device",
    admin_required: "Could not verify the Butler app.",
    advanced: "Advanced",
    advanced_contents: "Allowed hosts for tunnels and proxies",
    hosts: "Host names",
    hosts_description: "Names a tunnel or proxy uses.",
    host_placeholder: "butler.example.com",
    content_hosts: "Output host",
    content_hosts_description: "Tunnel hostname for opening outputs remotely.",
    content_host_placeholder: "content.example.com",
    host_count: |count| match count {
        0 => "None".to_owned(),
        1 => "1 host".to_owned(),
        n => format!("{n} hosts"),
    },
    add_host: "Add",
    remove_host: |host| format!("Remove {host}"),
    invalid_host: "Enter a host name or IP",
    just_now: "this minute",
    minutes_ago: |n| plural(n, "minute"),
    hours_ago: |n| plural(n, "hour"),
    yesterday: "yesterday",
    days_ago: |n| plural(n, "day"),
};

/// "1 minute ago", "5 minutes ago".
fn plural(count: u64, unit: &str) -> String {
    let s = if count == 1 { "" } else { "s" };
    format!("{count} {unit}{s} ago")
}

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
