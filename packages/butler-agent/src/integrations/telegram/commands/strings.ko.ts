// Korean UI strings for Telegram commands. All user-facing text lives here —
// handlers must not hold string literals.
//
// Placeholders use {key} interpolation. Tone: polite noun-form, persona-neutral
// (no honorifics, no fixed 합니다체). English tech terms may be mixed.
//
// Future languages: add sibling strings.<lang>.ts and dispatch via
// config.user.language.

export const STRINGS = {
  common: {
    processing: "⏳ 처리 중…",
    cancel: "취소",
    confirm: "확인",
    back: "뒤로",
    close: "닫기",
    undo: "실행 취소",
    in_flight: "진행 중입니다.",
    menu_expired: "메뉴가 만료되었습니다. 명령을 다시 실행해주세요.",
    unknown_action: "알 수 없는 동작: {action}",
  },
  topic: {
    empty_state: "이 명령은 forum topic 안에서만 동작합니다.",
    root_title: "현재 토픽: {name}",
    root_rename: "✏️ 이름 변경",
    root_archive: "📦 보관",
    root_info: "ℹ️ 정보",
    rename: {
      prompt: "다음 메시지에 새 이름을 보내주세요. {ttl}초 내에 입력해주세요.",
      confirm: "새 이름: {name}",
      ok: "이름이 변경되었습니다.",
      fail: "이름 변경 실패: {reason}",
      invalid: "이름은 1~128자여야 합니다.",
    },
    archive: {
      confirm_button: "📦 보관",
      confirm: "이 토픽을 보관합니다. 대화와 디렉토리는 남아있습니다. 보관 전 메모리를 정리합니다.",
      consolidating: "⏳ 메모리 정리 중…",
      ok: "보관되었습니다.",
      undo_ok: "보관이 취소되었습니다.",
      fail: "보관 실패: {reason}",
      consolidate_fail: "메모리 정리 실패: {reason}",
    },
    restore: {
      empty: "보관된 토픽이 없습니다.",
      ok: "복구되었습니다.",
      fail: "복구 실패: {reason}",
      picker_title: "복구할 토픽을 선택해주세요.",
    },
    info: {
      title: "토픽 정보",
      line_thread: "thread_id: {tid}",
      line_name: "이름: {name}",
      line_slug: "slug: {slug}",
      line_project: "프로젝트: {project}",
      line_path: "경로: {path}",
      line_cwd: "세션 CWD: {cwd}",
      line_archived: "상태: 보관 (archived {ts})",
      line_active: "상태: 활성",
      line_no_project: "프로젝트: (미첨부)",
    },
  },
  project: {
    empty_state_no_topic: "먼저 forum topic 에 진입해주세요.",
    header_attached: "현재 프로젝트: {name}",
    header_detached: "현재 프로젝트: (미첨부)",
    root_attach: "📎 연결",
    root_switch: "🔄 변경",
    root_detach: "🔗 연결 해제",
    root_info: "ℹ️ 정보",
    root_list: "📋 목록",
    attach: {
      picker_title: "연결할 프로젝트를 선택해주세요.",
      manual: "경로 직접 입력",
      manual_prompt: "다음 메시지에 프로젝트 경로를 보내주세요. {ttl}초 내에 입력해주세요.",
      manual_invalid: "유효한 경로가 아닙니다.",
      confirm: "{topic} 을(를) {project} 에 연결합니다.",
      ok: "연결되었습니다.",
      fail: "연결 실패: {reason}",
      warn_running_session: "현재 세션 CWD 는 {cwd} 입니다. 다음 메시지부터 {path} 에서 시작합니다.",
    },
    detach: {
      confirm: "이 토픽은 {cwd} 로 복귀합니다.",
      ok: "연결이 해제되었습니다.",
      undo_ok: "연결이 복구되었습니다.",
      fail: "해제 실패: {reason}",
    },
    list: {
      title: "토픽 × 프로젝트 목록",
      row_attached: "[{name}]",
      row_detached: "[—]",
      row_archived: "[📦 archived]",
    },
    info: {
      line_name: "이름: {name}",
      line_path: "경로: {path}",
      line_path_missing: "⚠️ 경로를 찾을 수 없습니다",
      line_last: "마지막 활동: {ts}",
      line_session: "세션: {name}",
      line_no_session: "세션: (없음)",
    },
  },
  autoregister: {
    registered: "📎 새 토픽으로 등록됨: {topicName} (slug: {slug}). /project 로 연결 가능합니다.",
    rate_limited: "자동 등록 한도를 초과했습니다. 수동으로 /topic 을 사용해주세요.",
    no_admin: "봇에 forum 관리 권한이 없습니다. topic 편집 기능이 제한됩니다.",
    failed: "자동 등록 실패: {reason}",
  },
  followups: {
    after_archive: ["↩ 복구"],
    after_detach: ["📎 다시 연결", "ℹ️ 정보"],
    after_attach: ["ℹ️ 정보", "🔗 해제"],
    after_rename: ["ℹ️ 정보", "📎 프로젝트 연결"],
  },
} as const;

export type Strings = typeof STRINGS;

// Dead-simple placeholder interpolation — {key} → vars[key]. Unrecognized
// placeholders are left intact so typos surface rather than silently blanking.
export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => {
    if (k in vars) return String(vars[k]);
    return m;
  });
}
