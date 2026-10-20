//! Foreign shell syntax runs as security logic on every host; native execution
//! is exercised by the command/access-tier E2Es.
use butler_platform::command_sandbox::{PathSyntax, screen_paths_with};
use std::{collections::HashMap, path::Path};

pub(super) fn verify() {
    foreign_credentials();
    recursive_and_name_patterns();
    let mut failures = Vec::new();
    let env = HashMap::from([
        ("BUTLER_DATA".into(), "/profiles/data".into()),
        ("USERPROFILE".into(), "/profiles/home".into()),
    ]);
    for (syntax, command, expected) in [
        (
            PathSyntax::PowerShell,
            "Get-Content $env:BUTLER_DATA/auth/token",
            "/profiles/data/auth/token",
        ),
        (
            PathSyntax::PowerShell,
            "Get-Content ${env:butler_data}/auth/token",
            "/profiles/data/auth/token",
        ),
        (
            PathSyntax::Cmd,
            "type %butler_data%/state/app-gateway/token",
            "/profiles/data/state/app-gateway/token",
        ),
        (
            PathSyntax::PowerShell,
            "Get-Content $HOME/.ssh/token",
            "/profiles/home/.ssh/token",
        ),
        (
            PathSyntax::PowerShell,
            "Get-Content ~/.ssh/token",
            "/profiles/home/.ssh/token",
        ),
        (
            PathSyntax::PowerShell,
            "Set-Location $env:BUTLER_DATA; Get-Content auth/token",
            "/profiles/data/auth/token",
        ),
        (
            PathSyntax::PowerShell,
            "PuSh-LoCaTiOn $env:BUTLER_DATA; gc auth/token",
            "/profiles/data/auth/token",
        ),
        (
            PathSyntax::PowerShell,
            "pushd $env:BUTLER_DATA; Push-Location /tmp; Pop-Location; gc auth/token",
            "/profiles/data/auth/token",
        ),
        (
            PathSyntax::Cmd,
            "cd /d %BUTLER_DATA% && type auth/token",
            "/profiles/data/auth/token",
        ),
        (
            PathSyntax::Posix,
            "cat \"$BUTLER_DATA\"\"/auth\"/token",
            "/profiles/data/auth/token",
        ),
    ] {
        let screen = screen_paths_with(command, Path::new("/work"), &env, syntax);
        if !screen.complete
            || screen.candidates.last().unwrap().path.as_deref() != Some(Path::new(expected))
        {
            failures.push(format!("wrong cwd: {command}"));
        }
    }
    for command in [
        "cd $unknown; cat relative",
        "p=x; cat $p",
        "cat $(pwd)/file",
        "eval opaque",
        "sh script.sh",
        "cd /data && (cd /tmp) && cat auth/probe.txt",
        "{ cd /data; } && cat auth/probe.txt",
        "if cd /data; then cat auth/probe.txt; fi",
        "command cd /data; cat auth/probe.txt",
        "builtin cd /data; cat auth/probe.txt",
        "cd /data; cd /; cd -; cat auth/probe.txt",
    ] {
        let screen = screen_paths_with(command, Path::new("/work"), &env, PathSyntax::Posix);
        if screen.complete {
            failures.push(format!("incorrectly complete: {command}"));
        }
    }
    let screen = screen_paths_with(
        "cd $unknown; cat relative",
        Path::new("/work"),
        &env,
        PathSyntax::Posix,
    );
    assert!(screen.candidates.last().unwrap().path.is_none());
    for (command, root, expected) in [
        ("cat $BUTLER_DATA/au*/token", "/profiles/data/auth", true),
        ("cat $BUTLER_DATA/*/token", "/profiles/data/auth", true),
        (
            "cat $BUTLER_DATA/ordinary*/token",
            "/profiles/data/auth",
            false,
        ),
        ("ls *.rs", "/work/.ssh", false),
        ("cat ~/.ssh/*", "/profiles/home/.ssh", true),
    ] {
        let screen = screen_paths_with(command, Path::new("/work"), &env, PathSyntax::Posix);
        assert_eq!(
            screen
                .candidates
                .last()
                .unwrap()
                .could_access(Path::new(root)),
            expected,
            "{command}"
        );
    }
    assert!(failures.is_empty(), "path screening failures: {failures:?}");
}

fn foreign_credentials() {
    let env = HashMap::from([
        ("BUTLER_DATA".into(), "/profiles/data".into()),
        ("USERPROFILE".into(), "/profiles/home".into()),
    ]);
    for relative in ["auth/token", "state/app-gateway/token"] {
        let expected = Path::new("/profiles/data").join(relative);
        for (syntax, command) in [
            (
                PathSyntax::PowerShell,
                format!("Get-Content \"$env:BUTLER_DATA\"/{relative}"),
            ),
            (
                PathSyntax::PowerShell,
                format!("Get-Content $env:butler_data/{relative}"),
            ),
            (
                PathSyntax::PowerShell,
                format!("Get-Content ${{env:BUTLER_DATA}}/{relative}"),
            ),
            (PathSyntax::Cmd, format!("type %BUTLER_DATA%/{relative}")),
            (
                PathSyntax::Cmd,
                format!("type \"%butler_data%\"/{relative}"),
            ),
        ] {
            let screen = screen_paths_with(&command, Path::new("/work"), &env, syntax);
            assert!(screen.complete, "{command}");
            assert_eq!(
                screen.candidates.last().unwrap().path.as_ref(),
                Some(&expected),
                "{command}"
            );
        }
    }
    let inventory =
        butler_platform::secure_fs::SecretInventory::new(Path::new("/profiles/data"), &env);
    assert!(
        inventory
            .paths()
            .contains(&Path::new("/profiles/home").join(".ssh"))
    );
}

fn recursive_and_name_patterns() {
    let env = HashMap::from([("BUTLER_DATA".into(), "/profiles/data".into())]);
    for command in [
        "grep -r token $BUTLER_DATA",
        "grep -r token $BUTLER_DATA/ap*",
    ] {
        let screen = screen_paths_with(command, Path::new("/work"), &env, PathSyntax::Posix);
        assert!(screen.complete, "{command}");
        assert!(
            screen
                .candidates
                .last()
                .unwrap()
                .could_reach(Path::new("/profiles/data/app/runtime/auth")),
            "{command}"
        );
    }
    for command in [
        "find . -name '*.pem'",
        "grep -r BEGIN --include='*.key' .",
        "rg -g '*.pem' BEGIN .",
        "rg -g*.pem BEGIN .",
    ] {
        let screen = screen_paths_with(command, Path::new("/work"), &env, PathSyntax::Posix);
        assert!(screen.complete, "{command}");
        assert!(
            !screen
                .candidates
                .iter()
                .any(|word| word.text.contains(".pem") || word.text.contains(".key")),
            "{command}"
        );
    }
}
