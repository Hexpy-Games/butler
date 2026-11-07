//! The copy of the authority decision card: `composer.permission`, `interfaceDetails` (allow
//! and deny), `interfaceTemplates.approvalRequest`, `conversation.imageTools`, `permissions` and
//! the modify dialog's `composer.approval` strings. Each method names its `packages/butler-i18n`
//! key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

mod schedule;

#[derive(Clone, Copy)]
pub(crate) struct Authority(Lang);

impl Authority {
    pub(crate) fn of(lang: Lang) -> Self {
        Self(lang)
    }

    pub(crate) fn get(cx: &App) -> Self {
        Self(Ds::get(cx).lang())
    }

    pub(crate) fn lang(self) -> Lang {
        self.0
    }

    fn pick(self, en: &'static str, ko: &'static str) -> &'static str {
        match self.0 {
            Lang::En => en,
            Lang::Ko => ko,
        }
    }

    /// composer.permission
    pub(crate) fn permission(self) -> &'static str {
        self.pick("Permission", "권한")
    }

    /// interfaceDetails.deny, allowOnce, allowInChat
    pub(crate) fn deny(self) -> &'static str {
        self.pick("Deny", "거부")
    }

    pub(crate) fn allow_once(self) -> &'static str {
        self.pick("Allow once", "이번만 허용")
    }

    pub(crate) fn allow_in_chat(self) -> &'static str {
        self.pick("Allow in this chat", "이 대화에서 허용")
    }

    /// interfaceDetails.allowSite, allowPaymentSite, allowSiteDescription
    pub(crate) fn allow_site(self) -> &'static str {
        self.pick("Always allow this site", "이 사이트는 항상 허용")
    }

    pub(crate) fn allow_payment_site(self) -> &'static str {
        self.pick("Always allow payments here", "이 사이트 결제는 항상 허용")
    }

    pub(crate) fn allow_site_description(self) -> &'static str {
        self.pick(
            "Turns on Use in all conversations. · Turn off in Settings › Browser.",
            "모든 대화에서 사용을 켭니다. · 설정 › 브라우저에서 끌 수 있습니다.",
        )
    }

    /// interfaceDetails.allowConversation, allowDescription
    pub(crate) fn allow_conversation(self) -> &'static str {
        self.pick(
            "Always allow in this conversation",
            "이 대화에서 계속 허용",
        )
    }

    pub(crate) fn allow_description(self) -> &'static str {
        self.pick(
            "Run this request and apply the permission to this conversation's child tasks.",
            "현재 요청을 실행하고, 이 대화의 하위 작업에도 적용합니다.",
        )
    }

    /// interfaceDetails.decisionFailed
    pub(crate) fn decision_failed(self) -> &'static str {
        self.pick(
            "Could not submit the decision. Try again.",
            "결정을 전달하지 못했습니다.",
        )
    }

    /// composer.approval.modify, modifyPlaceholder, submitModify; cancel
    pub(crate) fn modify(self) -> &'static str {
        self.pick(
            "Modify or suggest another approach",
            "수정 또는 다른 방법 제안",
        )
    }

    pub(crate) fn modify_placeholder(self) -> &'static str {
        self.pick(
            "Describe the approach Butler should take instead",
            "대신 수행할 방법을 입력하세요",
        )
    }

    pub(crate) fn submit_modify(self) -> &'static str {
        self.pick("Submit suggestion", "제안 제출")
    }

    pub(crate) fn cancel(self) -> &'static str {
        self.pick("Cancel", "취소")
    }

    /// interfaceTemplates.pendingApprovals
    pub(crate) fn pending_approvals(self, count: usize) -> String {
        match self.0 {
            Lang::En => format!(
                "{count} pending {}",
                if count == 1 { "approval" } else { "approvals" }
            ),
            Lang::Ko => format!("허용 대기 {count}개"),
        }
    }

    /// interfaceTemplates.approvalRequest.risk.{low, medium, high}
    pub(crate) fn risk(self, risk: crate::ui::source::Risk) -> &'static str {
        use crate::ui::source::Risk;
        match risk {
            Risk::Low => self.pick("Low risk", "위험 낮음"),
            Risk::Medium => self.pick("Medium risk", "위험 보통"),
            Risk::High => self.pick("High risk", "위험 높음"),
        }
    }

    /// interfaceTemplates.approvalRequest.browserMode
    pub(crate) fn browser_mode(self, signed_in: bool) -> &'static str {
        if signed_in {
            self.pick("Signed in", "로그인 사용")
        } else {
            self.pick("Without signing in", "로그인 없이")
        }
    }

    /// interfaceTemplates.approvalRequest.signInStep
    pub(crate) fn sign_in_step(self, reason: &str) -> &'static str {
        match reason {
            "mfa" => self.pick("Two-step verification", "2단계 인증"),
            "passkey" => self.pick("Passkey", "패스키"),
            "captcha" => self.pick("CAPTCHA", "보안 문자"),
            "secure_keypad" => self.pick("Security keypad", "보안 키패드"),
            _ => self.pick("Check sign-in form", "로그인 양식 확인"),
        }
    }

    /// interfaceTemplates.approvalRequest.waitHandoff
    pub(crate) fn wait_handoff(self, reason: &str) -> &'static str {
        match reason {
            "sign_in" => self.pick("Sign-in needed", "로그인 필요"),
            "secure_field" => self.pick("Your input needed", "직접 입력 필요"),
            "secure_keypad" => self.pick("Security keypad needs you", "보안 키패드 입력 필요"),
            "captcha" => self.pick("CAPTCHA needs you", "보안 문자 입력 필요"),
            _ => self.pick("Needs you in the tab", "직접 확인 필요"),
        }
    }

    /// interfaceTemplates.approvalRequest.payStep
    pub(crate) fn pay_step(self, reason: &str) -> &'static str {
        match reason {
            "secure_keypad" => self.pick("Security keypad", "보안 키패드"),
            "app_auth" => self.pick("Card app approval", "카드사 앱 인증"),
            "otp" => self.pick("Verification code", "인증번호"),
            "three_ds" => self.pick("Card issuer check", "카드사 본인 인증"),
            "captcha" => self.pick("CAPTCHA", "보안 문자"),
            _ => self.pick("Check the payment page", "결제 화면 확인"),
        }
    }

    /// interfaceTemplates.approvalRequest.payHandoff, signInHandoff.{title, inTab, onDesktop}
    pub(crate) fn pay_handoff(self) -> &'static str {
        self.pick("Payment needs you", "결제 확인 필요")
    }

    pub(crate) fn sign_in_handoff_title(self) -> &'static str {
        self.pick("Sign-in needs you", "로그인 확인 필요")
    }

    pub(crate) fn handoff_in_tab(self) -> &'static str {
        self.pick(
            "Finish in the tab, then give it back to Butler",
            "탭에서 마친 뒤 버틀러에게 돌려주세요",
        )
    }

    pub(crate) fn handoff_on_desktop(self) -> &'static str {
        self.pick("Finish this on your computer", "PC의 버틀러에서 확인해 주세요")
    }

    /// interfaceTemplates.approvalRequest.browserStep
    pub(crate) fn browser_step(self, action: &str, role: &str, name: &str, frame: &str) -> String {
        let join = |parts: Vec<String>| parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
        let text = match self.0 {
            Lang::En => {
                let verb = match action {
                    "click" => "Click",
                    "fill" => "Fill",
                    "select" => "Select",
                    "hover" => "Hover over",
                    "scroll" => "Scroll",
                    "drag" => "Drag",
                    "press" => "Press a key in",
                    "type" => "Type into",
                    "wait" => "Wait",
                    other => other,
                };
                let target = if role == "wait" {
                    String::new()
                } else if role == "focus" {
                    "the focused element".to_owned()
                } else if !name.is_empty() {
                    format!("the ‘{name}’ {role}")
                } else {
                    format!("the {role}")
                };
                join(vec![verb.to_owned(), target])
            }
            Lang::Ko => {
                let verb = match action {
                    "click" => "클릭",
                    "fill" | "type" => "입력",
                    "select" => "선택",
                    "hover" => "가리키기",
                    "scroll" => "스크롤",
                    "drag" => "끌기",
                    "press" => "키 누르기",
                    "wait" => "기다리기",
                    other => other,
                };
                let role = match role {
                    "button" => "버튼",
                    "link" => "링크",
                    "textbox" => "입력란",
                    "combobox" => "선택란",
                    "focus" => "현재 포커스에",
                    "document" => "페이지에",
                    "wait" => "",
                    other => other,
                };
                let name = if name.is_empty() { String::new() } else { format!("‘{name}’") };
                join(vec![name, role.to_owned(), verb.to_owned()])
            }
        };
        if frame.is_empty() { text } else { format!("{text} · {frame}") }
    }

    /// interfaceTemplates.approvalRequest.operation
    pub(crate) fn operation(self, tool: &str, read_only: bool) -> String {
        match self.0 {
            Lang::En => format!("{tool} · {}?", if read_only { "Read only" } else { "Change" }),
            Lang::Ko => format!("{tool} · {} 허용할까요?", if read_only { "읽기 전용" } else { "변경" }),
        }
    }

    fn in_workspace(self, workspace: Option<&str>) -> String {
        match (self.0, workspace) {
            (Lang::En, Some(w)) => format!("in '{w}'"),
            (Lang::En, None) => "in this folder".to_owned(),
            (Lang::Ko, Some(w)) => format!("'{w}'"),
            (Lang::Ko, None) => "이 작업 폴더".to_owned(),
        }
    }

    /// interfaceTemplates.approvalRequest.editFiles
    pub(crate) fn edit_files(self, count: i64, workspace: Option<&str>) -> String {
        match self.0 {
            Lang::En => format!("Edit {} {}?", en_files(count), self.in_workspace(workspace)),
            Lang::Ko => format!("{}의 {} 수정할까요?", self.in_workspace(workspace), ko_files(count)),
        }
    }

    pub(crate) fn edit_files_outside(self, count: i64) -> String {
        match self.0 {
            Lang::En => format!("Edit {}, including outside the project folder?", en_files(count)),
            Lang::Ko => format!("작업 폴더 밖을 포함한 {} 수정할까요?", ko_files(count)),
        }
    }

    pub(crate) fn run_command(self, workspace: Option<&str>) -> String {
        match self.0 {
            Lang::En => format!("Run a command {}?", self.in_workspace(workspace)),
            Lang::Ko => format!("{}에서 명령을 실행할까요?", self.in_workspace(workspace)),
        }
    }

    pub(crate) fn run_command_outside(self) -> &'static str {
        self.pick(
            "Run a command outside the project folder?",
            "작업 폴더 밖에서 명령을 실행할까요?",
        )
    }

    pub(crate) fn network_command(self, workspace: Option<&str>) -> String {
        match self.0 {
            Lang::En => format!("Run a command that uses the internet {}?", self.in_workspace(workspace)),
            Lang::Ko => format!("{}에서 인터넷을 쓰는 명령을 실행할까요?", self.in_workspace(workspace)),
        }
    }

    pub(crate) fn network_command_outside(self) -> &'static str {
        self.pick(
            "Run a command that uses the internet outside the project folder?",
            "작업 폴더 밖에서 인터넷을 쓰는 명령을 실행할까요?",
        )
    }

    pub(crate) fn web_request(self) -> &'static str {
        self.pick("Send this web request?", "웹 요청을 보낼까요?")
    }

    pub(crate) fn web_request_desc(self) -> &'static str {
        self.pick(
            "This request may carry outside content.",
            "외부에서 읽은 내용이 포함될 수 있습니다.",
        )
    }

    pub(crate) fn taint_reason(self) -> &'static str {
        self.pick(
            "Asking again because this turn read outside content.",
            "방금 외부에서 가져온 내용을 읽어서 다시 확인합니다.",
        )
    }

    pub(crate) fn unsandboxed_reason(self) -> &'static str {
        self.pick(
            "Runs without a sandbox · can read secret files",
            "샌드박스 없이 실행 · 비밀 파일을 읽을 수 있음",
        )
    }

    pub(crate) fn read_only_unisolated(self) -> &'static str {
        self.pick("Read-only request · No isolation", "읽기 전용 요청 · 격리 없음")
    }

    /// interfaceTemplates.approvalRequest.useConnector
    pub(crate) fn use_connector(self, tool: Option<&str>, server: Option<&str>) -> String {
        match (self.0, tool, server) {
            (Lang::En, Some(t), Some(s)) => format!("Use {t} from {s}?"),
            (Lang::En, Some(t), None) => format!("Use {t}?"),
            (Lang::En, None, _) => "Use a connected tool?".to_owned(),
            (Lang::Ko, Some(t), Some(s)) => format!("{s}의 {t} 도구를 사용할까요?"),
            (Lang::Ko, Some(t), None) => format!("{t} 도구를 사용할까요?"),
            (Lang::Ko, None, _) => "연결된 도구를 사용할까요?".to_owned(),
        }
    }

    /// interfaceTemplates.approvalRequest.manageSchedule.{create, delete, run, change}
    pub(crate) fn manage_schedule(self, operation: &str) -> &'static str {
        match operation {
            "create" => self.pick("Create a schedule?", "예약 작업을 만들까요?"),
            "delete" => self.pick("Delete a schedule?", "예약 작업을 삭제할까요?"),
            "run" => self.pick("Run due schedules?", "예정된 예약 작업을 실행할까요?"),
            _ => self.pick("Change a schedule?", "예약 작업을 변경할까요?"),
        }
    }

    pub(crate) fn update_project(self) -> &'static str {
        self.pick("Update the project records?", "프로젝트 기록을 업데이트할까요?")
    }

    pub(crate) fn start_conversation(self) -> &'static str {
        self.pick("Start a new conversation?", "새 대화를 시작할까요?")
    }

    pub(crate) fn restart_service(self) -> &'static str {
        self.pick("Restart Butler?", "버틀러를 다시 시작할까요?")
    }

    pub(crate) fn create_worktree(self) -> &'static str {
        self.pick(
            "Create a worktree for this conversation?",
            "이 대화용 워크트리를 만들까요?",
        )
    }

    pub(crate) fn switch_folder(self) -> &'static str {
        self.pick("Move the working folder?", "작업 폴더를 옮길까요?")
    }

    pub(crate) fn generic(self) -> &'static str {
        self.pick("Allow this action?", "이 작업을 허용할까요?")
    }

    /// interfaceTemplates.approvalRequest.more
    pub(crate) fn more(self, count: i64) -> String {
        match self.0 {
            Lang::En => format!("+{count} more"),
            Lang::Ko => format!("외 {count}개"),
        }
    }

    /// interfaceTemplates.approvalRequest.covers.{editFiles, command, other}
    pub(crate) fn covers_edit_files(self, workspace: Option<&str>) -> String {
        match self.0 {
            Lang::En => format!("File edits {}", self.in_workspace(workspace)),
            Lang::Ko => format!("{}의 파일 수정", self.in_workspace(workspace)),
        }
    }

    pub(crate) fn covers_command(self, workspace: Option<&str>) -> String {
        match self.0 {
            Lang::En => format!("This command {}", self.in_workspace(workspace)),
            Lang::Ko => format!("{}에서 이 명령 실행", self.in_workspace(workspace)),
        }
    }

    pub(crate) fn covers_other(self) -> &'static str {
        self.pick("This same action", "같은 작업")
    }
}

fn en_files(count: i64) -> String {
    match count {
        c if c > 0 => format!("{c} {}", if c == 1 { "file" } else { "files" }),
        _ => "files".to_owned(),
    }
}

fn ko_files(count: i64) -> String {
    if count > 0 { format!("파일 {count}개를") } else { "파일을".to_owned() }
}
