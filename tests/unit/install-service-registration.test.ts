import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";

const root = process.cwd();

function runInstallerFunction(script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-lc", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      BUTLER_NO_GUM: "1",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("installer OS service registration defaults to no mutation in non-interactive mode", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    NON_INTERACTIVE=true
    source ./install.sh
    if should_register_os_service_noninteractive; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("no");
});

test("installer OS service registration supports explicit non-interactive opt-in", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    NON_INTERACTIVE=true
    BUTLER_REGISTER_SERVICE=1
    source ./install.sh
    if should_register_os_service_noninteractive; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("yes");
});

test("installer OS service registration supports explicit non-interactive opt-out", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    NON_INTERACTIVE=true
    BUTLER_REGISTER_SERVICE=0
    source ./install.sh
    if should_register_os_service_noninteractive; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("no");
});

test("installer OS service registration flags override environment defaults", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    NON_INTERACTIVE=true
    BUTLER_REGISTER_SERVICE=1
    source ./install.sh --no-register-service
    if should_register_os_service_noninteractive; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("no");
});

test("installer explicit language selection does not prompt", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh --language ko
    tl_choose() { echo should-not-prompt; exit 42; }
    select_install_language
    echo "$INSTALL_LANG"
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ko");
});

test("docker installer preinstalls container dependencies before running install script", () => {
  const source = readFileSync("tools/install-in-docker.sh", "utf8");
  const dependencyBlockIndex = source.indexOf("install_container_dependencies");
  const installIndex = source.indexOf("exec ./install.sh");

  expect(dependencyBlockIndex).toBeGreaterThan(-1);
  expect(installIndex).toBeGreaterThan(dependencyBlockIndex);
  expect(source).toContain("-e BUTLER_INSTALL_IN_DOCKER=1");
  expect(source).toContain("apt-get install -y --no-install-recommends");
  for (const packageName of [
    "ca-certificates",
    "curl",
    "git",
    "unzip",
    "build-essential",
    "python3",
    "pkg-config",
    "procps",
  ]) {
    expect(source).toContain(packageName);
  }
});

test("release docker verification installs from service artifact and checks health", () => {
  const source = readFileSync("tools/verify-service-release-in-docker.sh", "utf8");
  const packageIndex = source.indexOf("release:service:package");
  const extractIndex = source.indexOf("tar -xzf");
  const installIndex = source.indexOf("./install.sh");
  const healthIndex = source.indexOf("http://127.0.0.1:18765/health");

  expect(packageIndex).toBeGreaterThan(-1);
  expect(extractIndex).toBeGreaterThan(packageIndex);
  expect(installIndex).toBeGreaterThan(extractIndex);
  expect(healthIndex).toBeGreaterThan(installIndex);
  expect(source).toContain("-v \"$ARTIFACT_PATH:/release/$ARTIFACT_NAME:ro\"");
  expect(source).toContain("-e BUTLER_ACCEPT_EXPERIMENTAL=1");
  expect(source).toContain("service-release-docker-health-ok");
});

test("interactive installer language selection uses chooser", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    unset BUTLER_INSTALL_LANG
    INSTALL_LANG=""
    source ./install.sh
    is_non_interactive_shell() { return 1; }
    tl_choose() {
      test "$1" = "English"
      test "$2" = "한국어"
      printf '%s\\n' "한국어"
    }
    select_install_language >/dev/null
    echo "$INSTALL_LANG"
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ko");
});

test("interactive installer accepts experimental disclaimer with chooser", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    source ./install.sh --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() { printf '%s\\n' "AGREE"; }
    show_dangerous_flags_disclaimer >/dev/null
    awk -F= '$1=="mode"{print $2}' "$tmp/.accepted-experimental"
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("select");
});

test("interactive installer aborts when experimental disclaimer is declined", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    source ./install.sh --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() { printf '%s\\n' "Not agree"; }
    show_dangerous_flags_disclaimer >/dev/null
  `);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Consent not granted");
});

test("timeline chooser supports up/down and left/right arrow keys", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    export BUTLER_TEST_FORCE_TL_CHOOSE_TTY=1
    down="$(printf '\\033[B\\n' | tl_choose One Two)"
    right="$(printf '\\033[C\\n' | tl_choose One Two)"
    up_wrap="$(printf '\\033[A\\n' | tl_choose One Two)"
    left_wrap="$(printf '\\033[D\\n' | tl_choose One Two)"
    printf '%s|%s|%s|%s\\n' "$down" "$right" "$up_wrap" "$left_wrap"
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Two|Two|Two|Two");
});

test("timeline chooser terminal detection allows captured stdout", () => {
  const source = readFileSync("install.sh", "utf8");
  const functionBody = source.match(/tl_choose_can_use_terminal_selector\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  expect(functionBody).toContain("-t 0");
  expect(functionBody).toContain("-t 2");
  expect(functionBody).not.toContain("-t 1");
});

test("installer interactivity detection allows captured stdout", () => {
  const source = readFileSync("install.sh", "utf8");
  const functionBody = source.match(/is_non_interactive_shell\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  expect(functionBody).toContain("-t 0");
  expect(functionBody).toContain("-t 2");
  expect(functionBody).not.toContain("! -t 1");
});

test("installer does not negate interactivity helper inside bash test brackets", () => {
  const source = readFileSync("install.sh", "utf8");

  expect(source).not.toMatch(/\[\[[^\]]+&& ! is_non_interactive_shell/);
});

test("non-interactive installer requires explicit experimental acceptance env", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export NON_INTERACTIVE=true
    source ./install.sh --data "$tmp" --language en --non-interactive
    show_dangerous_flags_disclaimer >/dev/null
  `);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("BUTLER_ACCEPT_EXPERIMENTAL=1");
});

test("non-interactive installer auto-installs missing dependencies when available", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    mkdir -p "$tmp/bin"
    export PATH="$tmp/bin:$PATH"
    source ./install.sh --non-interactive
    install_cmd="printf '%s\\\\n' '#!/usr/bin/env bash' 'echo fake dep 1.0' > '$tmp/bin/fake-dep' && chmod +x '$tmp/bin/fake-dep'"
    ensure_dependency fake-dep "$install_cmd" "fake dep" >/dev/null
    fake-dep --version
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("fake dep 1.0");
});

test("plain confirm prompts trim surrounding whitespace", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    if printf ' y  \\n' | prompt_confirm "Proceed?" >/dev/null; then
      echo yes
    else
      echo no
    fi
    if printf ' no  \\n' | tl_confirm "Proceed?" >/dev/null; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("yes\nno");
});

test("interactive installer OS service registration uses chooser and defaults to yes", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    is_non_interactive_shell() { return 1; }
    os_service_registration_unavailable_reason() { return 1; }
    tl_choose() {
      touch "$tmp/service-chooser-called"
      test "$1" = "Yes"
      test "$2" = "No"
      printf '%s\\n' "Yes"
    }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    INSTALL_LANG=en
    if select_os_service_registration >/dev/null; then
      test -f "$tmp/service-chooser-called"
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("yes");
});

test("interactive installer OS service registration can be declined with chooser", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    is_non_interactive_shell() { return 1; }
    os_service_registration_unavailable_reason() { return 1; }
    tl_choose() {
      test "$1" = "Yes"
      test "$2" = "No"
      printf '%s\\n' "No"
    }
    INSTALL_LANG=en
    if select_os_service_registration >/dev/null; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("no");
});

test("interactive installer OS service registration can be declined with flag", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh --no-register-service
    is_non_interactive_shell() { return 1; }
    os_service_registration_unavailable_reason() { return 1; }
    tl_choose() { echo should-not-prompt; exit 42; }
    INSTALL_LANG=en
    if select_os_service_registration >/dev/null; then
      echo yes
    else
      echo no
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("no");
});

test("interactive installer skips OS service registration inside Docker", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh --language ko
    INSTALL_LANG=ko
    OS_TYPE=Linux
    is_non_interactive_shell() { return 1; }
    running_in_container() { return 0; }
    tl_choose() { echo should-not-prompt; exit 42; }
    if select_os_service_registration; then
      echo registered
    else
      echo "$OS_SERVICE_REGISTRATION_RESULT"
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("unavailable");
  expect(result.stdout).toContain("Docker/컨테이너");
  expect(result.stdout).not.toContain("should-not-prompt");
});

test("explicit OS service registration opt-in is blocked when unavailable", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh --register-service
    INSTALL_LANG=en
    OS_TYPE=Linux
    is_non_interactive_shell() { return 1; }
    os_service_registration_unavailable_reason() {
      echo "systemd --user is not available in this session."
      return 0
    }
    if select_os_service_registration; then
      echo registered
    else
      echo "$OS_SERVICE_REGISTRATION_RESULT"
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("unavailable");
  expect(result.stdout).toContain("systemd --user is not available");
});

test("linux OS service registration requires systemctl, booted systemd, and user manager", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    printf '%s\\n' '#!/usr/bin/env bash' 'exit 1' > "$tmp/systemctl"
    chmod +x "$tmp/systemctl"
    export PATH="$tmp:$PATH"
    source ./install.sh
    running_in_container() { return 1; }
    OS_TYPE=Linux

    linux_systemd_booted() { return 1; }
    os_service_registration_unavailable_reason

    linux_systemd_booted() { return 0; }
    os_service_registration_unavailable_reason
  `);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("systemd does not appear to be booted");
  expect(result.stdout).toContain("systemd --user is not available");
});

test("macOS OS service registration requires launchctl user domain", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    printf '%s\\n' '#!/usr/bin/env bash' 'printf "%s\\\\n" "$*" > "$LAUNCHCTL_ARGS_FILE"' 'exit 0' > "$tmp/launchctl"
    chmod +x "$tmp/launchctl"
    export PATH="$tmp:$PATH"
    export LAUNCHCTL_ARGS_FILE="$tmp/launchctl.args"
    source ./install.sh
    running_in_container() { return 1; }
    OS_TYPE=Darwin

    if os_service_registration_unavailable_reason; then
      echo unavailable
    else
      echo available
    fi
    cat "$LAUNCHCTL_ARGS_FILE"
  `);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("available");
  expect(result.stdout).toContain("print gui/");
});

test("installer keeps OS service failure visible before manual fallback", () => {
  const source = readFileSync("install.sh", "utf8");
  const failureBranch = source.match(/ui_warn "OS service registration failed; starting manual native services instead"[\s\S]*?OS_SERVICE_REGISTRATION_RESULT="failed"/)?.[0] ?? "";

  expect(failureBranch).toContain("pause_for_os_service_failure");
});

test("non-interactive installer gateway defaults to Butler App without chooser", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    source ./install.sh --data "$tmp" --language en --non-interactive
    is_non_interactive_shell() { return 0; }
    tl_choose() { echo should-not-prompt; exit 42; }
    configure_gateway >/dev/null
    [[ -z "\${BOT_TOKEN:-}" && -z "\${CHAT_ID:-}" ]]
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive installer gateway can choose Butler App from list", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() {
      touch "$tmp/gateway-chooser-called"
      test "$1" = "Butler App"
      test "$2" = "Telegram"
      printf '%s\\n' "Butler App"
    }
    configure_gateway >/dev/null
    test -f "$tmp/gateway-chooser-called"
    test ! -f "$tmp/config/telegram-transport.json"
    [[ -z "\${BOT_TOKEN:-}" && -z "\${CHAT_ID:-}" ]]
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive installer gateway can choose Telegram from list", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export BUTLER_BUN='${bun}'
    export BUTLER_TELEGRAM_TOKEN=bot-token-preview
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() {
      touch "$tmp/gateway-chooser-called"
      test "$1" = "Butler App"
      test "$2" = "Telegram"
      printf '%s\\n' "Telegram"
    }
    telegram_detect_chat_id() { printf '%s\\n' "12345"; }
    configure_gateway >/dev/null
    test -f "$tmp/gateway-chooser-called"
    test -f "$tmp/config/telegram-transport.json"
    grep -q '^TELEGRAM_BOT_TOKEN=bot-token-preview$' "$tmp/.env"
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("explicit Codex subscription provider uses profile without chooser", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    mkdir -p "$tmp/auth"
    printf '{}' > "$tmp/auth/openai-codex.json"
    export BUTLER_BUN='${bun}'
    export BUTLER_MODEL_PROVIDER=codex-subscription
    export BUTLER_CODEX_AUTH_PROFILE="$tmp/auth/openai-codex.json"
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() { echo should-not-prompt; exit 42; }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive installer provider chooser lists hosted providers and local last", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() {
      test "$1" = "Open AI (API Key)"
      test "$2" = "Open AI (Codex subscription)"
      test "$3" = "Anthropic"
      test "$4" = "Google Gemini"
      test "$5" = "xAI / Grok"
      test "$6" = "Qwen Cloud"
      test "$7" = "Moonshot / Kimi"
      test "$8" = "Local OpenAI-compatible model"
      printf '%s\\n' "Local OpenAI-compatible model"
    }
    select_install_provider_choice
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("local");
  expect(result.stderr).toContain("Local model is the last option.");
  expect(result.stderr).not.toContain("default choice");
});

test("interactive installer provider chooser can choose OpenAI API key", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    unset BUTLER_OPENAI_AUTH_METHOD BUTLER_OPENAI_API_KEY OPENAI_API_KEY BUTLER_CODEX_AUTH_PROFILE BUTLER_OPENAI_AUTH_PROFILE
    export BUTLER_BUN='${bun}'
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() {
      touch "$tmp/provider-chooser-called"
      printf '%s\\n' "Open AI (API Key)"
    }
    tl_secret_input() { printf '%s\\n' "sk-preview"; }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    test -f "$tmp/provider-chooser-called"
    CFG="$tmp/butler.config.json" CREDS="$tmp/auth/model-provider-credentials.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const creds = JSON.parse(await Bun.file(process.env.CREDS).text());
      if (cfg.system.defaultModel !== 'openai/gpt-5.5') throw new Error('OpenAI provider should use catalog default');
      const cred = creds.credentials?.find((item) => item.provider_id === 'openai');
      if (!cred || cred.secret !== 'sk-preview') throw new Error('OpenAI credential was not stored');
    "
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive installer provider chooser can choose Codex subscription", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    unset BUTLER_OPENAI_AUTH_METHOD BUTLER_OPENAI_API_KEY OPENAI_API_KEY BUTLER_CODEX_AUTH_PROFILE BUTLER_OPENAI_AUTH_PROFILE
    export BUTLER_BUN='${bun}'
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() {
      touch "$tmp/provider-chooser-called"
      printf '%s\\n' "Open AI (Codex subscription)"
    }
    codex_subscription_profile_exists() { return 1; }
    codex_subscription_login() { touch "$tmp/codex-login-called"; return 0; }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    test -f "$tmp/provider-chooser-called"
    test -f "$tmp/codex-login-called"
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive installer provider chooser can register Anthropic API key", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    unset BUTLER_MODEL_PROVIDER BUTLER_INSTALL_MODEL_PROVIDER BUTLER_MODEL_REF
    export BUTLER_BUN='${bun}'
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() { printf '%s\\n' "Anthropic"; }
    tl_secret_input() { printf '%s\\n' "sk-ant-preview"; }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    CFG="$tmp/butler.config.json" CREDS="$tmp/auth/model-provider-credentials.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const creds = JSON.parse(await Bun.file(process.env.CREDS).text());
      if (cfg.system.defaultModel !== 'anthropic/claude-opus-4-7') throw new Error('Anthropic catalog default was not selected');
      const cred = creds.credentials?.find((item) => item.provider_id === 'anthropic');
      if (!cred || cred.secret !== 'sk-ant-preview') throw new Error('Anthropic credential was not stored');
    "
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("installer can configure a local OpenAI-compatible model as the default", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export BUTLER_BUN='${bun}'
    export BUTLER_MODEL_PROVIDER=local
    export BUTLER_LOCAL_MODEL_SERVER_URL=http://127.0.0.1:8080
    export BUTLER_LOCAL_MODEL_PLATFORM=llama_cpp
    export BUTLER_LOCAL_MODEL_ID=gemma-test
    export BUTLER_LOCAL_CONTEXT_WINDOW_TOKENS=32768
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    tl_choose() { echo should-not-prompt; exit 42; }
    tl_secret_input() { echo should-not-prompt; exit 42; }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    CFG="$tmp/butler.config.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const model = cfg.models?.local?.find((item) => item.model_ref === 'local/gemma-test');
      if (!model) throw new Error('local model was not registered');
      if (model.server_url !== 'http://127.0.0.1:8080') throw new Error('local server URL mismatch');
      if (model.platform !== 'llama_cpp') throw new Error('local model platform mismatch');
      if (model.context_window_tokens !== 32768) throw new Error('local context window mismatch');
      if (cfg.system.defaultModel !== 'local/gemma-test') throw new Error('default model should use the local ref');
      if (cfg.system.butlerModel !== 'local/gemma-test') throw new Error('butler model should use the local ref');
    "
    test ! -s "$tmp/.env" || ! grep -q '^OPENAI_API_KEY=' "$tmp/.env"
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive local model setup prompts for a model id when discovery is empty", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export BUTLER_BUN='${bun}'
    export BUTLER_MODEL_PROVIDER=local
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    discover_local_models_json() { return 0; }
    tl_choose() { printf '%s\\n' "Custom"; }
    tl_input() {
      case "$1" in
        "Local model server URL") printf '%s\\n' "https://llmpen.com/api/vllm" ;;
        "Local model id") touch "$tmp/model-id-prompted"; printf '%s\\n' "gemma-4-31B-it" ;;
        "Context window tokens") printf '%s\\n' "\${2:-32768}" ;;
        *) echo "unexpected prompt: $1" >&2; exit 43 ;;
      esac
    }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >"$tmp/configure.out"
    grep -q "Could not discover a model id automatically" "$tmp/configure.out"
    test -f "$tmp/model-id-prompted"
    CFG="$tmp/butler.config.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const model = cfg.models?.local?.find((item) => item.model_ref === 'local/gemma-4-31B-it');
      if (!model) throw new Error('manual local model was not registered');
      if (model.server_url !== 'https://llmpen.com/api/vllm') throw new Error('manual local URL mismatch');
      if (cfg.system.defaultModel !== 'local/gemma-4-31B-it') throw new Error('manual local model should be default');
    "
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive local model setup auto-registers the first discovered model", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export BUTLER_BUN='${bun}'
    export BUTLER_MODEL_PROVIDER=local
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    discover_local_models_json() {
      cat <<'JSON'
{"models":[{"model_id":"gemma-auto","model_ref":"local/gemma-auto","context_window_tokens":128000}]}
JSON
    }
    tl_choose() { echo "unexpected choose prompt" >&2; exit 42; }
    tl_input() {
      case "$1" in
        "Local model server URL") printf '%s\\n' "https://llmpen.com/api/vllm" ;;
        *) echo "unexpected input prompt: $1" >&2; exit 43 ;;
      esac
    }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    CFG="$tmp/butler.config.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const model = cfg.models?.local?.find((item) => item.model_ref === 'local/gemma-auto');
      if (!model) throw new Error('auto-discovered local model was not registered');
      if (model.server_url !== 'https://llmpen.com/api/vllm') throw new Error('auto local URL mismatch');
      if (model.platform !== 'custom') throw new Error('auto local platform should stay custom');
      if (model.context_window_tokens !== 128000) throw new Error('auto local context window mismatch');
      if (cfg.system.defaultModel !== 'local/gemma-auto') throw new Error('auto local model should be default');
    "
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("interactive local model setup falls back to a numeric context before registration", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export BUTLER_BUN='${bun}'
    export BUTLER_MODEL_PROVIDER=local
    export BUTLER_LOCAL_CONTEXT_WINDOW_TOKENS='   '
    source ./install.sh --home "$PWD" --data "$tmp" --language en
    is_non_interactive_shell() { return 1; }
    discover_local_models_json() {
      cat <<'JSON'
{"models":[{"model_id":"gemma-no-context","model_ref":"local/gemma-no-context"}]}
JSON
    }
    tl_choose() { echo "unexpected choose prompt" >&2; exit 42; }
    tl_input() {
      case "$1" in
        "Local model server URL") printf '%s\\n' "https://llmpen.com/api/vllm" ;;
        *) echo "unexpected input prompt: $1" >&2; exit 43 ;;
      esac
    }
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    CFG="$tmp/butler.config.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const model = cfg.models?.local?.find((item) => item.model_ref === 'local/gemma-no-context');
      if (!model) throw new Error('auto-discovered local model was not registered');
      if (model.context_window_tokens !== 32768) throw new Error('context window should fall back to 32768');
      if (cfg.system.defaultModel !== 'local/gemma-no-context') throw new Error('auto local model should be default');
    "
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

test("installer skipped OS service path documents the later registration command", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    OS_SERVICE_REGISTRATION_RESULT=manual
    print_os_service_later_hint
  `);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("butler service install --yes");
});

test("installer does not start manual services after successful OS service registration", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    run_quiet_step() { return 0; }
    setup_services() { echo duplicate-manual-start; return 0; }
    if setup_os_service_registration >/dev/null; then
      echo "$OS_SERVICE_REGISTRATION_RESULT"
    else
      setup_services
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("registered");
  expect(result.stdout).not.toContain("duplicate-manual-start");
});

test("installer does not start manual services when service registration leaves services online", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    run_quiet_step() {
      if [[ "$1" == "Stopping existing manual services" ]]; then
        return 0
      fi
      return 1
    }
    native_services_online() { return 0; }
    setup_services() { echo duplicate-manual-start; return 0; }
    if setup_os_service_registration >/dev/null; then
      echo "$OS_SERVICE_REGISTRATION_RESULT"
    else
      setup_services
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("failed-active");
  expect(result.stdout).not.toContain("duplicate-manual-start");
});

test("installer blocks OS service registration when manual services cannot be stopped", () => {
  const result = runInstallerFunction(`
    set -euo pipefail
    source ./install.sh
    run_quiet_step() { return 1; }
    native_services_online() { return 0; }
    setup_services() { echo duplicate-manual-start; return 0; }
    if setup_os_service_registration >/dev/null; then
      echo "$OS_SERVICE_REGISTRATION_RESULT"
    else
      setup_services
    fi
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("blocked");
  expect(result.stdout).not.toContain("duplicate-manual-start");
});

test("installer health check reports runtime adapter and selected model separately", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp_home="$(mktemp -d)"
    tmp_data="$(mktemp -d)"
    trap 'rm -rf "$tmp_home" "$tmp_data"' EXIT
    mkdir -p "$tmp_home/packages/butler-agent/scripts" "$tmp_data"
    cat > "$tmp_home/packages/butler-agent/scripts/service-control.sh" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "ps" ]]; then
  printf '%s\\n' '{"services":[{"serviceId":"butler-main","status":"online"}]}'
fi
SH
    chmod +x "$tmp_home/packages/butler-agent/scripts/service-control.sh"
    export BUTLER_BUN='${bun}'
    source ./install.sh --home "$tmp_home" --data "$tmp_data" --language en
    cat > "$CONFIG_PATH" <<'JSON'
{"system":{"runtime":"codex-api","defaultModel":"local/gemma-health","butlerModel":"local/gemma-health"}}
JSON
    health_check
  `);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("runtime adapter: codex-api");
  expect(result.stdout).toContain("model selected: local/gemma-health");
  expect(result.stdout).not.toContain("native runtime selected");
});

test("minimal non-interactive installer prepares first-chat onboarding without user profile prompts", () => {
  const bun = process.execPath.replace(/'/g, "'\\''");
  const result = runInstallerFunction(`
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    export NON_INTERACTIVE=true
    export BUTLER_BUN='${bun}'
    export BUTLER_MODEL_PROVIDER=openai
    export BUTLER_OPENAI_AUTH_METHOD=api-key
    export BUTLER_OPENAI_API_KEY=sk-test
    export BUTLER_GATEWAY=app
    source ./install.sh --home "$PWD" --data "$tmp" --non-interactive --no-register-service
    INSTALL_LANG=en
    OS_TYPE="$(uname -s)"
    setup_directories >/dev/null
    configure_api_provider >/dev/null
    initialize_first_chat_onboarding_state >/dev/null
    configure_gateway >/dev/null
    BUTLER_HOME="$PWD" BUTLER_DATA="$tmp" bash packages/butler-agent/scripts/doctor.sh --check config --quiet >/dev/null
    CFG="$tmp/butler.config.json" ONBOARDING="$tmp/personalization/onboarding.json" "$BUTLER_BUN" -e "
      const cfg = JSON.parse(await Bun.file(process.env.CFG).text());
      const onboarding = JSON.parse(await Bun.file(process.env.ONBOARDING).text());
      if (cfg.user.name !== '') throw new Error('user.name should stay empty before first chat onboarding');
      if (cfg.system.runtime !== 'codex-api') throw new Error('runtime should be codex-api');
      if (cfg.webSearch.provider !== 'duckduckgo-html') throw new Error('web search should default to no-key provider');
      if (cfg.webSearch.readerBackend !== 'lightweight') throw new Error('reader backend should default to lightweight');
      if (onboarding.status !== 'pending') throw new Error('first-chat onboarding should be pending');
      if (onboarding.gateway !== 'any') throw new Error('onboarding should be gateway-neutral');
    "
    echo ok
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
  expect(result.stderr).not.toContain("BUTLER_USER_NAME");
});
