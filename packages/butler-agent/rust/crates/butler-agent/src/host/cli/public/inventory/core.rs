use super::Entry;

pub(super) const ROUTES: &[Entry] = &[
    route!(
        "install",
        "butler install --from ARCHIVE|URL [--sha256 HEX] [--no-restart]",
        "Butler를 설치합니다. / Install Butler.",
        "core"
    ),
    route!(
        "start",
        "butler start [--dry-run] [--data PATH]",
        "서비스를 시작합니다. / Start the service.",
        "core"
    ),
    route!(
        "stop",
        "butler stop [--data PATH]",
        "서비스를 중지합니다. / Stop the service.",
        "core"
    ),
    route!(
        "restart",
        "butler restart [--data PATH]",
        "서비스를 재시작합니다. / Restart the service.",
        "core"
    ),
    route!(
        "status",
        "butler status [--data PATH]",
        "서비스 상태를 봅니다. / Show service status.",
        "core"
    ),
    route!(
        "open",
        "butler open [--no-browser] [--json] [--data PATH]",
        "Butler를 엽니다. / Open Butler.",
        "core"
    ),
    route!(
        "remote.status",
        "butler remote status [--json]",
        "원격 접근 상태를 봅니다. / Show remote access.",
        "core",
        true
    ),
    route!(
        "remote.enable",
        "butler remote enable",
        "원격 접근을 켭니다. / Enable remote access.",
        "core",
        false
    ),
    route!(
        "remote.disable",
        "butler remote disable",
        "원격 접근을 끕니다. / Disable remote access.",
        "core",
        false
    ),
    route!(
        "remote.pair",
        "butler remote pair",
        "기기를 연결합니다. / Pair a device.",
        "core",
        false
    ),
    route!(
        "remote.devices",
        "butler remote devices [--json] [--revoke ID|--revoke-all]",
        "연결된 기기를 관리합니다. / Manage paired devices.",
        "core",
        true
    ),
    route!(
        "remote.hosts.add",
        "butler remote hosts add HOST",
        "허용 호스트를 추가합니다. / Add an allowed host.",
        "core",
        false
    ),
    route!(
        "remote.hosts.remove",
        "butler remote hosts remove HOST",
        "허용 호스트를 제거합니다. / Remove an allowed host.",
        "core",
        false
    ),
    route!(
        "doctor",
        "butler doctor [--check NAME|--collect-logs] [--data PATH]",
        "설치와 서비스를 점검합니다. / Diagnose installation and service.",
        "core"
    ),
    route!(
        "update",
        "butler update [--check|--apply --yes]",
        "업데이트를 확인하거나 설치합니다. / Check for or install updates.",
        "core"
    ),
    route!(
        "rollback",
        "butler rollback [--to VERSION] [--yes] [--dry-run] [--no-restart]",
        "이전 버전으로 되돌립니다. / Roll back.",
        "core"
    ),
    route!(
        "uninstall",
        "butler uninstall [--keep-data|--purge-data] --yes [--dry-run]",
        "Butler를 제거합니다. / Uninstall Butler.",
        "core"
    ),
    route!(
        "startup.enable",
        "butler startup enable",
        "로그인 시 시작합니다. / Enable start at login.",
        "core"
    ),
    route!(
        "startup.disable",
        "butler startup disable",
        "로그인 시 시작을 끕니다. / Disable start at login.",
        "core"
    ),
    route!(
        "startup.status",
        "butler startup status",
        "자동 시작 상태를 봅니다. / Show start at login status.",
        "core"
    ),
    route!(
        "auth.login",
        "butler auth login",
        "모델 계정에 연결합니다. / Sign in.",
        "core"
    ),
    route!(
        "auth.logout",
        "butler auth logout",
        "모델 계정 연결을 끊습니다. / Sign out.",
        "core"
    ),
    route!(
        "auth.status",
        "butler auth status",
        "계정 연결 상태를 봅니다. / Show sign-in status.",
        "core"
    ),
    route!(
        "model.list",
        "butler model list",
        "모델 목록을 봅니다. / List models.",
        "core"
    ),
    route!(
        "model.status",
        "butler model status",
        "모델 상태를 봅니다. / Show model status.",
        "core"
    ),
    route!(
        "model.set",
        "butler model set MODEL",
        "모델을 선택합니다. / Select a model.",
        "core"
    ),
    route!(
        "logs",
        "butler logs [--service NAME]",
        "서비스 로그를 봅니다. / View service logs.",
        "core"
    ),
    route!(
        "schedule.list",
        "butler schedule list",
        "예약 작업 목록을 봅니다. / List schedules.",
        "core"
    ),
    route!(
        "schedule.show",
        "butler schedule show ID",
        "예약 작업을 봅니다. / Show a schedule.",
        "core"
    ),
    route!(
        "schedule.create",
        "butler schedule create --prompt TEXT --session ID [--interval-seconds N|--run-at ISO] [--title TEXT] [--start-at ISO] [--access-mode MODE] [--schedule-type TYPE]",
        "예약 작업을 만듭니다. / Create a schedule.",
        "core"
    ),
    route!(
        "schedule.update",
        "butler schedule update ID [--prompt TEXT] [--session ID] [--interval-seconds N] [--run-at ISO] [--start-at ISO] [--title TEXT] [--state STATE] [--access-mode MODE] [--schedule-type TYPE]",
        "예약 작업을 수정합니다. / Update a schedule.",
        "core"
    ),
    route!(
        "schedule.run",
        "butler schedule run ID",
        "예약 작업을 실행합니다. / Run a schedule.",
        "core"
    ),
    route!(
        "schedule.delete",
        "butler schedule delete ID",
        "예약 작업을 삭제합니다. / Delete a schedule.",
        "core"
    ),
    route!(
        "mcp.list",
        "butler mcp list",
        "MCP 서버 목록을 봅니다. / List MCP servers.",
        "core"
    ),
    route!(
        "mcp.add",
        "butler mcp add",
        "MCP 서버를 추가합니다. / Add an MCP server.",
        "core"
    ),
    route!(
        "mcp.enable",
        "butler mcp enable ID",
        "MCP 서버를 켭니다. / Enable an MCP server.",
        "core"
    ),
    route!(
        "mcp.disable",
        "butler mcp disable ID",
        "MCP 서버를 끕니다. / Disable an MCP server.",
        "core"
    ),
    route!(
        "mcp.delete",
        "butler mcp delete ID --yes",
        "MCP 서버를 삭제합니다. / Delete an MCP server.",
        "core"
    ),
    route!(
        "mcp.test",
        "butler mcp test ID",
        "MCP 서버 연결을 점검합니다. / Test an MCP server.",
        "core"
    ),
    route!(
        "skills.list",
        "butler skills list",
        "스킬 목록을 봅니다. / List skills.",
        "core"
    ),
    route!(
        "skills.import",
        "butler skills import PATH",
        "스킬을 가져옵니다. / Import skills.",
        "core"
    ),
    route!(
        "config.get",
        "butler config get KEY",
        "설정을 봅니다. / Read a setting.",
        "core"
    ),
    route!(
        "config.set",
        "butler config set KEY VALUE",
        "설정을 바꿉니다. / Change a setting.",
        "core"
    ),
    route!(
        "help",
        "butler help [command]",
        "도움말을 봅니다. / Show help.",
        "core"
    ),
    route!(
        "version",
        "butler version [--json]",
        "버전을 봅니다. / Show version.",
        "core"
    ),
    route!(
        "--version",
        "butler --version, -V",
        "릴리스 버전과 빌드 ID를 봅니다. / Show release version and build ID.",
        "core",
        false,
        &["-V"]
    ),
];
