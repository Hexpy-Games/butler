//! Pure MXC foundations run unchanged on every host.
use butler_platform::command_sandbox::{
    Invocation, Level, SandboxCapabilities,
    mxc_policy::{
        self, WinPath,
        command_line::command_line,
        drive_pick::{self, Reconcile},
        environment,
        policy::Plan,
        toolchain::{self, Discovery, Msvc},
    },
};
use std::collections::BTreeMap;
/// Policy planning and admission invariants of the command sandbox contract.
pub(super) fn verify() {
    golden_policy_has_no_implicit_environment_network_or_fallback();
    policy_rejects_broad_and_overriding_grants();
    toolchains_replace_shims_and_keep_trusted_path_order();
    environment_redirects_profiles_without_importing_host_credentials();
    drive_picker_and_reconcile_never_remove_other_owners_mapping();
    command_lines_round_trip_crt_arguments_and_preserve_cmd_text();
    mutation_predicate_requires_project_boundary_and_network_only();
}
fn path(value: &str) -> WinPath {
    WinPath::new(value).unwrap()
}
fn host() -> BTreeMap<String, String> {
    [
        ("SYSTEMROOT", r"C:\Windows"),
        ("USERPROFILE", r"C:\Users\person"),
        ("APPDATA", r"C:\Users\person\AppData\Roaming"),
        ("LOCALAPPDATA", r"C:\Users\person\AppData\Local"),
    ]
    .map(|(k, v)| (k.into(), v.into()))
    .into()
}
fn plan() -> Plan {
    Plan {
        project: path(r"C:\work\project"),
        data: path(r"C:\Users\person\.butler"),
        host_environment: host(),
        tools: toolchain::Toolchain::default(),
        secrets: vec![
            path(r"C:\work\project\sub\.env"),
            path(r"C:\work\project\sub\.git"),
        ],
        credentials: environment::credential_roots(&host()).unwrap(),
    }
}
fn invocation(args: &[&str]) -> Invocation {
    Invocation {
        program: r"C:\Program Files\tool.exe".into(),
        arguments: args.iter().map(|s| (*s).into()).collect(),
    }
}
fn golden_policy_has_no_implicit_environment_network_or_fallback() {
    let result = plan().build(&invocation(&["argument"]), 'L', 1500).unwrap();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("mxc-policy.json")).unwrap();
    assert_eq!(result, expected);
}
fn policy_rejects_broad_and_overriding_grants() {
    for root in [
        r"C:\",
        r"C:\Users\person",
        r"C:\Users",
        r"C:\Users\person\AppData",
        r"C:\Users\person\.ssh\project",
        r"C:\Users\person\.butler\other",
    ] {
        let mut p = plan();
        p.project = path(root);
        p.secrets.clear();
        assert!(p.build(&invocation(&[]), 'L', 1500).is_err(), "{root}");
    }
    let mut p = plan();
    p.tools
        .readonly
        .push(path(r"C:\work\project\sub\.env\child"));
    assert!(p.build(&invocation(&[]), 'L', 1500).is_err());
    let mut p = plan();
    p.secrets.push(path(r"C:\outside\.env"));
    assert!(p.build(&invocation(&[]), 'L', 1500).is_err());
    assert!(plan().build(&invocation(&[]), 'C', 1500).is_err());
    assert!(plan().build(&invocation(&[]), 'L', 500).is_err());
    for value in [
        r"C:relative",
        r"\\server\share",
        r"\\?\C:\work",
        r"C:\work\..\escape",
        r"C:\work\file:stream",
        r"C:\work\trailing.",
        r"C:\work\NUL",
        r"C:\work\\child",
        r"C:\PROGRA~1\Tools",
        r"C:\Users\PERSON~1.ABC",
    ] {
        assert!(WinPath::new(value).is_err(), "{value}");
    }
    assert_eq!(path(r"C:\WORK\한글"), path("c:/work/한글/"));
    assert!(!path(r"C:\work-other").is_within(&path(r"C:\work")));
    // A read-only Cargo home still denies its nested credential files.
    let mut p = plan();
    p.tools.readonly.push(path(r"C:\Users\person\.cargo"));
    p.credentials
        .push(path(r"C:\Users\person\.cargo\credentials.toml"));
    assert!(p.build(&invocation(&[]), 'L', 1500).is_ok());
    let mut p = plan();
    p.tools.readonly.push(path(r"C:\private"));
    p.credentials.push(path(r"C:\private\credentials"));
    assert!(p.build(&invocation(&[]), 'L', 1500).is_err());
}
fn toolchains_replace_shims_and_keep_trusted_path_order() {
    let input = Discovery {
        path: [
            r"C:\bad",
            r"C:\Users\person\.nodejs",
            r"C:\Users\person\AppData\Local\Microsoft\WindowsApps",
            r"C:\Windows\System32",
            r"C:\Program Files\other",
            r"C:\Users\person\AppData\Roaming\npm",
            r"C:\Users\person\AppData\Local\Programs\Python\Python312",
            r"C:\Users\person\AppData\Local\Programs\Python\untrusted",
        ]
        .map(path)
        .into(),
        system_root: Some(path(r"C:\Windows")),
        program_files: vec![path(r"C:\Program Files")],
        install_roots: vec![path(r"C:\Users\person\nvm\installs")],
        cargo_home: Some(path(r"C:\Users\person\.cargo")),
        rustup_home: Some(path(r"C:\Users\person\.rustup")),
        git_exe: Some(path(r"C:\Program Files\Git\cmd\git.exe")),
        app_data: Some(path(r"C:\Users\person\AppData\Roaming")),
        local_app_data: Some(path(r"C:\Users\person\AppData\Local")),
        shim_dirs: vec![path(r"C:\Users\person\.nodejs")],
        real_node: Some(path(r"C:\Users\person\nvm\installs\v24")),
        cargo_config_has_token: true,
        cargo_entries: vec!["credentials.backup".into(), "ordinary".into()],
        msvc: None,
    };
    let tools = toolchain::discover(&input).unwrap();
    assert_eq!(
        tools.path,
        [
            r"C:\Users\person\nvm\installs\v24",
            r"C:\Users\person\.cargo\bin",
            r"C:\Program Files\Git\cmd",
            r"C:\Windows\System32",
            r"C:\Program Files\other",
            r"C:\Users\person\AppData\Roaming\npm",
            r"C:\Users\person\AppData\Local\Programs\Python\Python312"
        ]
        .map(path)
    );
    assert!(
        tools
            .denied
            .contains(&path(r"C:\Users\person\.cargo\config.toml"))
    );
    assert!(
        tools
            .denied
            .contains(&path(r"C:\Users\person\.cargo\config"))
    );
    assert!(WinPath::new(r"C:\work\name~v2").is_ok());
    assert!(!tools.readonly.contains(&path(r"C:\Program Files")));
    assert!(
        tools
            .denied
            .contains(&path(r"C:\Users\person\.cargo\credentials.backup"))
    );
    let mut untrusted = input.clone();
    untrusted.real_node = Some(path(r"C:\untrusted\node"));
    assert!(toolchain::discover(&untrusted).is_err());
    untrusted = input.clone();
    untrusted.git_exe = Some(path(r"C:\untrusted\cmd\git.exe"));
    assert!(toolchain::discover(&untrusted).is_err());
    let mut input = input;
    input.msvc = Some(Msvc {
        tools: path(r"C:\VS\VC\Tools\MSVC\14.44"),
        kits_lib: path(r"C:\Kits\Lib\10.0.26100.0"),
        architecture: "x64".into(),
        triple: "x86_64-pc-windows-msvc".into(),
    });
    let tools = toolchain::discover(&input).unwrap();
    assert_eq!(
        tools.environment["CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER"],
        r"c:\vs\vc\tools\msvc\14.44\bin\hostx64\x64\link.exe"
    );
    assert_eq!(
        tools.environment["LIB"],
        r"c:\vs\vc\tools\msvc\14.44\lib\x64;c:\kits\lib\10.0.26100.0\ucrt\x64;c:\kits\lib\10.0.26100.0\um\x64"
    );
}
fn environment_redirects_profiles_without_importing_host_credentials() {
    let mut host = host();
    host.insert("CODEX_AUTH_JSON".into(), String::new());
    assert!(environment::credential_roots(&host).is_ok());
    host.insert("TOKEN".into(), "private".into());
    host.insert("NODE_OPTIONS".into(), "--preserve-symlinks".into());
    host.insert("RUSTUP_TOOLCHAIN".into(), "nightly".into());
    host.insert("CARGO_HOME".into(), r"C:\Users\person\.cargo".into());
    let tools = toolchain::discover(&Discovery {
        real_node: Some(path(r"C:\installs\node")),
        install_roots: vec![path(r"C:\installs")],
        ..Discovery::default()
    })
    .unwrap();
    let env = environment::build(&host, &path(r"C:\scratch"), &tools, &path(r"L:\")).unwrap();
    for key in ["TOKEN", "NODE_OPTIONS", "RUSTUP_TOOLCHAIN"] {
        assert!(!env.contains_key(key));
    }
    assert_eq!(env["USERPROFILE"], r"c:\scratch\home");
    assert_eq!(env["HOMEDRIVE"], "c:");
    assert_eq!(env["HOMEPATH"], r"\scratch\home");
    assert_eq!(env["PATH"], r"c:\scratch\bin;c:\installs\node");
    assert_eq!(env["CARGO_HOME"], host["CARGO_HOME"]);
    assert_eq!(env["BUTLER_COMMAND_CWD"], r"l:\");
    let roots = environment::credential_roots(&host).unwrap();
    assert!(roots.contains(&path(r"C:\Users\person\AppData\Roaming\Microsoft\Protect")));
    let settings = BTreeMap::from([
        ("user.name".into(), "A \"quoted\" name".into()),
        ("credential.helper".into(), "host-helper".into()),
    ]);
    let config = environment::git_config(&settings, 'L').unwrap();
    assert!(config.contains(r#"name = "A \"quoted\" name""#));
    assert!(!config.contains("host-helper"));
    assert!(config.contains("directory = L:/"));
}
fn drive_picker_and_reconcile_never_remove_other_owners_mapping() {
    assert_eq!(drive_pick::candidates(1 << 25, &['y'], &['X'])[0], 'W');
    assert_eq!(drive_pick::candidates(u32::MAX, &[], &[]), [] as [char; 0]);
    let target = path(r"C:\project");
    let other = path(r"C:\other");
    assert_eq!(
        drive_pick::subst_listing("L:\\: => C:\\project\r\n"),
        Ok(vec![('L', target.clone())])
    );
    assert_eq!(drive_pick::subst_listing("invalid output"), Ok(Vec::new()));
    assert_eq!(
        drive_pick::reconcile(true, &target, Some(&target)),
        Reconcile::Keep
    );
    assert_eq!(
        drive_pick::reconcile(false, &target, Some(&target)),
        Reconcile::Unmap
    );
    assert_eq!(
        drive_pick::reconcile(false, &target, Some(&other)),
        Reconcile::Forget
    );
    assert_eq!(
        drive_pick::reconcile(false, &target, None),
        Reconcile::Forget
    );
    for (code, reason) in [
        (0xC000_0142, "non_interactive_desktop"),
        (1314, "privilege_not_held"),
        (126, "mxc_api_missing"),
        (127, "mxc_api_missing"),
        (1, "probe_failed"),
    ] {
        assert_eq!(mxc_policy::reason_code(code), reason);
    }
}
fn command_lines_round_trip_crt_arguments_and_preserve_cmd_text() {
    let arguments = [
        "",
        "plain",
        "with space",
        "tabs\there",
        r#"a\"quote"#,
        "trailing\\",
        "space and trailing\\",
        "한글 ✓",
        "\\\\\"quote",
    ];
    let line = command_line(&invocation(&arguments)).unwrap();
    let mut expected = vec![r"C:\Program Files\tool.exe".to_owned()];
    expected.extend(arguments.map(String::from));
    assert_eq!(parse_crt(&line), expected);
    let cmd = Invocation {
        program: r"C:\Windows\System32\cmd.exe".into(),
        arguments: vec![
            "/d".into(),
            "/s".into(),
            "/c".into(),
            r#"echo "quoted" & dir "%USERPROFILE%""#.into(),
        ],
    };
    assert_eq!(
        command_line(&cmd).unwrap(),
        r#""C:\Windows\System32\cmd.exe" /d /s /c "echo "quoted" & dir "%USERPROFILE%"""#
    );
    assert!(command_line(&invocation(&["bad\0arg"])).is_err());
    assert!(command_line(&invocation(&[&"x".repeat(32767)])).is_err());
}
// Independent CRT decoder for semantic round trips, not a source-string check.
fn parse_crt(line: &str) -> Vec<String> {
    let mut chars = line.chars().peekable();
    let mut result = Vec::new();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| matches!(c, ' ' | '\t')) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while let Some(&ch) = chars.peek() {
            if !quoted && matches!(ch, ' ' | '\t') {
                break;
            }
            let mut slashes = 0;
            while chars.peek() == Some(&'\\') {
                chars.next();
                slashes += 1;
            }
            if chars.peek() == Some(&'"') {
                arg.extend(std::iter::repeat_n('\\', slashes / 2));
                chars.next();
                if slashes % 2 == 1 {
                    arg.push('"');
                } else {
                    quoted = !quoted;
                }
            } else {
                arg.extend(std::iter::repeat_n('\\', slashes));
                if !quoted && chars.peek().is_some_and(|c| matches!(c, ' ' | '\t')) {
                    break;
                }
                if let Some(c) = chars.next() {
                    arg.push(c);
                }
            }
        }
        result.push(arg);
    }
    result
}
fn mutation_predicate_requires_project_boundary_and_network_only() {
    let levels = [
        Level::Enforced,
        Level::Partial("limited"),
        Level::Unavailable("absent"),
    ];
    for project_write in levels {
        for network_deny in levels {
            for read_only in levels {
                let caps = SandboxCapabilities {
                    project_write,
                    network_deny,
                    read_only,
                    process_scoping: Level::Unavailable("unused"),
                    private_reads: Level::Unavailable("unused"),
                    write_protection: Level::Unavailable("unused"),
                };
                assert_eq!(
                    caps.project_write_available(),
                    !matches!(project_write, Level::Unavailable(_))
                        && network_deny == Level::Enforced
                );
            }
        }
    }
    // Linux probe has always required seccomp + ioctl(v5) + scopes(v6) for
    // project_write, the same bits needed for an enforced read_only boundary.
    let caps = butler_platform::command_sandbox::capabilities();
    if butler_platform::command_sandbox::project_write_mechanism() == "landlock" {
        let old = !matches!(caps.project_write, Level::Unavailable(_))
            && caps.network_deny.is_enforced()
            && caps.read_only.is_enforced();
        assert_eq!(caps.project_write_available(), old);
    }
}
