use super::*;

pub(super) fn boundaries() {
    for command in [
        "cat $HOME/x",
        "ls %USERPROFILE%",
        "ls !USERPROFILE!",
        "cat `pwd`",
        "ls /tmp/*",
        "cat {..,a}/outside.txt",
        "cd && cat .zsh_history",
        "cd -- && cat .zsh_history",
        "cd '' && cat .zsh_history",
        "pushd",
        "popd",
        "cat .en?",
        "cat [.]env",
        "ls *.rs",
        "cd /var && cat file",
        "chdir /var",
        "(cd /var && cat file)",
        "if true; then command cd /var; fi",
        "builtin cd /var",
        "command -p cd /var",
        "A=b cd /var",
        "cd /var | true; cat file",
        "cd /absent; cat file",
        "pushd /var",
        "Set-Location C:\\Users",
        "sl C:/Users",
        "Push-Location C:/Users",
        "Pop-Location",
        "CD..",
        "cd\\",
        "cd/",
        "cat \"/var\"/file",
        "cat \"/var\"\"/file\"",
        "cat /v'a'r/file",
        "cat a/../b",
        "cat ..",
        "cat C:\\a\\..\\b",
        "cat \"a b/../c\"",
        "cat --opt=\"/var\"/auth/x",
        "cat --opt=\"a\"\"b\"",
        "cat \"a\"\"b\"",
        "bash -c \"cd /var && cat auth/probe.txt\"",
        "sh -c 'cd /var && cat auth/probe.txt'",
        "eval \"cd /var; cat auth/probe.txt\"",
        "cmd /c \"cd /var && cat auth/probe.txt\"",
        "pwsh -Command \"Set-Location /var\"",
        "iex \"cd /var; cat auth/probe.txt\"",
        "echo 'cd /var'",
        "echo 'cat a/../b'",
        "bash -c \"sh -c 'cd /var'\"",
        "eval cd /var",
        "time cd /var",
        "exec cd /var",
        "coproc cd /var",
        "noglob cd /var",
        "nocorrect cd /var",
        "call cd /var",
    ] {
        assert!(command_scope_unresolved(command), "{command}");
    }
    for command in [
        "ls ~",
        "cat ~/work/a.txt",
        "cat notes.txt",
        "ls",
        "git status",
        "echo hi > out.txt",
        "cat 'ordinary file'",
        "cat \"ordinary file\"",
        "echo cd /var",
        "if true; then cat ordinary; fi",
        "command cat ordinary",
        "cat a/.../b",
        r"cat 'a\b'",
        "cat --opt=\"ordinary file\"",
        "KEY=\"ordinary value\" cat notes.txt",
        "cat --opt='ordinary file'",
        "KEY='ordinary value' cat notes.txt",
    ] {
        assert!(!command_scope_unresolved(command), "{command}");
    }
    if butler_platform::command_sandbox::POSIX_SHELL {
        for command in [r"cat /d/au\th/x", r"cat My\ Dir/x"] {
            assert!(command_scope_unresolved(command), "{command}");
        }
    }
    if !butler_platform::command_sandbox::POSIX_SHELL {
        for command in [
            "cmd /c cd",
            "cmd /c cd C:/Users",
            "powershell -Command \"pushd C:/Users\"",
            "powershell.exe -Command \"ls ~\"",
        ] {
            assert!(command_scope_unresolved(command), "{command}");
        }
    }
}
