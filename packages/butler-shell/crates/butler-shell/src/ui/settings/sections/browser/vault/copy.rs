//! The copy of the sign-ins and vault sections. Each field names its `packages/butler-i18n`
//! key (`settings.signIns`, `settings.vault`, `settings.pageSections`).
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// pageSections.signIns
    pub(super) title_sign_ins: &'static str,
    /// pageSections.paymentMethods
    pub(super) title_payment_methods: &'static str,
    /// pageSections.profiles
    pub(super) title_profiles: &'static str,
    /// pageSections.purchaseSites
    pub(super) title_purchase_sites: &'static str,
    /// signIns.empty
    pub(super) empty_sign_ins: &'static str,
    /// signIns.username
    pub(super) username: &'static str,
    /// signIns.password
    pub(super) password: &'static str,
    /// signIns.policyLabel
    pub(super) policy_label: &'static str,
    /// signIns.policy.always / ask / never
    pub(super) policy: [&'static str; 3],
    /// signIns.noPassword
    pub(super) no_password: &'static str,
    /// signIns.conversations
    pub(super) conversations: fn(usize) -> String,
    /// signIns.lastUsed
    pub(super) last_used: fn(&str) -> String,
    /// signIns.notUsed
    pub(super) not_used: &'static str,
    /// signIns.allConversations
    pub(super) all_conversations: &'static str,
    /// signIns.deletePassword
    pub(super) delete_password: &'static str,
    /// signIns.deleteConfirm
    pub(super) delete_password_confirm: fn(&str) -> String,
    /// signIns.revoke
    pub(super) revoke: &'static str,
    /// signIns.revokeConfirm
    pub(super) revoke_confirm: fn(&str) -> String,
    /// signIns.revoked
    pub(super) revoked: &'static str,
    /// signIns.failed
    pub(super) sign_in_failed: &'static str,
    /// vault.unavailable (signIns.unavailable is the same copy)
    pub(super) unavailable: &'static str,
    /// vault.emptyCards
    pub(super) empty_cards: &'static str,
    /// vault.emptyProfiles
    pub(super) empty_profiles: &'static str,
    /// vault.emptyPurchaseSites
    pub(super) empty_purchase_sites: &'static str,
    /// vault.add
    pub(super) add: &'static str,
    /// vault.save
    pub(super) save: &'static str,
    /// vault.cancel
    pub(super) cancel: &'static str,
    /// vault.edit
    pub(super) edit: &'static str,
    /// vault.delete
    pub(super) delete: &'static str,
    /// vault.saved
    pub(super) saved: &'static str,
    /// vault.failed
    pub(super) failed: &'static str,
    /// vault.nickname
    pub(super) nickname: &'static str,
    /// vault.cardNumber
    pub(super) card_number: &'static str,
    /// vault.expiry
    pub(super) expiry: &'static str,
    /// vault.cvc
    pub(super) cvc: &'static str,
    /// vault.holderName
    pub(super) holder_name: &'static str,
    /// vault.pin2
    pub(super) pin2: &'static str,
    /// vault.ownerId
    pub(super) owner_id: &'static str,
    /// vault.keepSecret
    pub(super) keep_secret: &'static str,
    /// vault.reveal
    pub(super) reveal: &'static str,
    /// vault.revealUnavailable
    pub(super) reveal_unavailable: &'static str,
    /// vault.hide
    pub(super) hide: &'static str,
    /// vault.expired
    pub(super) expired: &'static str,
    /// vault.deleteConfirm
    pub(super) delete_confirm: fn(&str) -> String,
    /// vault.askEveryTime
    pub(super) ask_every_time: &'static str,
    /// vault.allowedSites
    pub(super) allowed_sites: fn(usize) -> String,
    /// vault.site
    pub(super) site: &'static str,
    /// vault.sitePlaceholder
    pub(super) site_placeholder: &'static str,
    /// vault.addSite
    pub(super) add_site: &'static str,
    /// vault.removeSite
    pub(super) remove_site: fn(&str) -> String,
    /// vault.profileName
    pub(super) profile_name: &'static str,
    /// vault.nameSection / contactSection / addressSection / otherSection
    pub(super) groups: [&'static str; 4],
    /// vault.passport
    pub(super) passport: &'static str,
    /// vault.idSection
    pub(super) id_section: &'static str,
    /// vault.gender
    pub(super) gender: &'static str,
    /// vault.genderOptions.M / F
    pub(super) gender_options: [&'static str; 2],
    /// vault labels of the profile fields, by the field's key
    pub(super) detail: fn(&str) -> &'static str,
    /// relative time ("1 hour ago") for `since`: minute, hour, day units
    pub(super) ago: fn(i64, Unit) -> String,
}

#[derive(Clone, Copy)]
pub(super) enum Unit {
    Minute,
    Hour,
    Day,
}

fn detail_en(key: &str) -> &'static str {
    match key {
        "name" => "Full name",
        "family_name" => "Family name",
        "given_name" => "Given name",
        "name_latin_surname" => "Surname (Latin)",
        "name_latin_given" => "Given name (Latin)",
        "organization" => "Organization",
        "country" => "Country",
        "postal_code" => "Postal code",
        "region" => "State / province",
        "city" => "City / district",
        "address_line1" => "Address line 1",
        "address_line2" => "Address line 2",
        "nationality" => "Nationality",
        "issuing_country" => "Issuing country",
        "passport_expiry" => "Passport expiry",
        "phone" => "Phone",
        "email" => "Email",
        "birth_date" => "Birth date",
        "passport_number" => "Passport number",
        _ => "",
    }
}

fn detail_ko(key: &str) -> &'static str {
    match key {
        "name" => "전체 이름",
        "family_name" => "성",
        "given_name" => "이름",
        "name_latin_surname" => "영문 성",
        "name_latin_given" => "영문 이름",
        "organization" => "소속",
        "country" => "국가",
        "postal_code" => "우편번호",
        "region" => "시/도",
        "city" => "시/군/구",
        "address_line1" => "주소",
        "address_line2" => "상세 주소",
        "nationality" => "국적",
        "issuing_country" => "발급 국가",
        "passport_expiry" => "여권 만료일",
        "phone" => "전화",
        "email" => "이메일",
        "birth_date" => "생년월일",
        "passport_number" => "여권 번호",
        _ => "",
    }
}

fn ago_en(count: i64, unit: Unit) -> String {
    let (name, one) = match unit {
        Unit::Minute => ("minute", "this minute"),
        Unit::Hour => ("hour", "an hour ago"),
        Unit::Day => ("day", "yesterday"),
    };
    match (count, unit) {
        (0, Unit::Minute) | (1, Unit::Day) => one.into(),
        (1, _) => format!("1 {name} ago"),
        _ => format!("{count} {name}s ago"),
    }
}

fn ago_ko(count: i64, unit: Unit) -> String {
    match (count, unit) {
        (0, Unit::Minute) => "지금".into(),
        (1, Unit::Day) => "어제".into(),
        (_, Unit::Minute) => format!("{count}분 전"),
        (_, Unit::Hour) => format!("{count}시간 전"),
        (_, Unit::Day) => format!("{count}일 전"),
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

const EN: Words = Words {
    title_sign_ins: "Sign-ins",
    title_payment_methods: "Payment methods",
    title_profiles: "My info",
    title_purchase_sites: "Pay without asking",
    empty_sign_ins: "No saved sign-ins",
    username: "Username",
    password: "Password",
    policy_label: "Butler signs in",
    policy: ["Always", "Ask", "Never"],
    no_password: "No password",
    conversations: |count| format!("Used in {}", plural(count, "conversation", "conversations")),
    last_used: |when| format!("Last used {when}"),
    not_used: "Not used yet",
    all_conversations: "Use in all conversations",
    delete_password: "Delete password",
    delete_password_confirm: |site| format!("Delete the password for {site}?"),
    revoke: "Remove Butler's access",
    revoke_confirm: |site| format!("Remove Butler's access to {site} in every conversation?"),
    revoked: "Access removed",
    sign_in_failed: "Couldn't complete that",
    unavailable: "Needs the system password store",
    empty_cards: "No saved cards",
    empty_profiles: "No saved profiles",
    empty_purchase_sites: "Butler asks before every payment",
    add: "Add",
    save: "Save",
    cancel: "Cancel",
    edit: "Edit",
    delete: "Delete",
    saved: "Saved",
    failed: "Couldn't do that",
    nickname: "Nickname",
    card_number: "Card number",
    expiry: "Expiry (MM/YY)",
    cvc: "CVC",
    holder_name: "Name on card",
    pin2: "First 2 numbers of card PIN",
    owner_id: "Birth date YYMMDD (or business number)",
    keep_secret: "Leave empty to keep",
    reveal: "Show number",
    reveal_unavailable: "Not available on this computer",
    hide: "Hide",
    expired: "Expired",
    delete_confirm: |name| format!("Delete {name}?"),
    ask_every_time: "Ask every time",
    allowed_sites: |count| format!("Fills without asking on {}", plural(count, "site", "sites")),
    site: "Sites that fill without asking",
    site_placeholder: "example.com",
    add_site: "Add site",
    remove_site: |site| format!("Remove {site}"),
    profile_name: "Profile name",
    groups: ["Name", "Contact", "Address", "Other"],
    passport: "Passport",
    id_section: "ID (optional)",
    gender: "Gender",
    gender_options: ["Male", "Female"],
    detail: detail_en,
    ago: ago_en,
};

const KO: Words = Words {
    title_sign_ins: "로그인",
    title_payment_methods: "결제 수단",
    title_profiles: "내 정보",
    title_purchase_sites: "확인 없이 결제",
    empty_sign_ins: "저장한 로그인 없음",
    username: "아이디",
    password: "비밀번호",
    policy_label: "버틀러 로그인",
    policy: ["항상", "묻기", "안 함"],
    no_password: "비밀번호 없음",
    conversations: |count| format!("대화 {count}개에서 사용"),
    last_used: |when| format!("최근 사용 {when}"),
    not_used: "사용 기록 없음",
    all_conversations: "모든 대화에서 사용",
    delete_password: "비밀번호 삭제",
    delete_password_confirm: |site| format!("{site} 비밀번호를 삭제할까요?"),
    revoke: "버틀러 접근 해제",
    revoke_confirm: |site| format!("모든 대화에서 {site} 접근을 해제할까요?"),
    revoked: "접근을 해제했어요",
    sign_in_failed: "처리하지 못했어요",
    unavailable: "시스템 암호 저장소가 있어야 쓸 수 있어요",
    empty_cards: "저장한 카드 없음",
    empty_profiles: "저장한 내 정보 없음",
    empty_purchase_sites: "결제할 때마다 확인해요",
    add: "추가",
    save: "저장",
    cancel: "취소",
    edit: "수정",
    delete: "삭제",
    saved: "저장했어요",
    failed: "처리하지 못했어요",
    nickname: "별칭",
    card_number: "카드 번호",
    expiry: "유효기간 (MM/YY)",
    cvc: "CVC",
    holder_name: "카드 소유자 이름",
    pin2: "카드 비밀번호 앞 2자리",
    owner_id: "생년월일 6자리 (법인은 사업자번호)",
    keep_secret: "그대로 두려면 비워 두세요",
    reveal: "번호 보기",
    reveal_unavailable: "이 컴퓨터에서는 번호를 볼 수 없어요",
    hide: "숨기기",
    expired: "만료됨",
    delete_confirm: |name| format!("{name}을(를) 삭제할까요?"),
    ask_every_time: "입력할 때마다 확인",
    allowed_sites: |count| format!("{count}개 사이트는 바로 입력"),
    site: "확인 없이 입력할 사이트",
    site_placeholder: "example.com",
    add_site: "사이트 추가",
    remove_site: |site| format!("{site} 삭제"),
    profile_name: "프로필 이름",
    groups: ["이름", "연락처", "주소", "기타"],
    passport: "여권",
    id_section: "신분증 (선택)",
    gender: "성별",
    gender_options: ["남", "여"],
    detail: detail_ko,
    ago: ago_ko,
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
