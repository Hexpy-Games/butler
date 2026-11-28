use butler_platform::powershell_text::encoded_command;

/// First lines of every PowerShell command.
pub(super) const PRELUDE: &str =
    "$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\n";

/// The remote home, data folder and the current agent ($X, or $null when not installed).
pub(super) const HOME: &str = r"$R=Join-Path $env:USERPROFILE '.butler-remote'
$D=Join-Path $R 'data'
$C=Join-Path $R 'current.txt'
$X=$null
if(Test-Path -LiteralPath $C){$X=Join-Path (Join-Path $R ([IO.File]::ReadAllText($C).Trim())) 'butler-agent.exe';if(-not(Test-Path -LiteralPath $X -PathType Leaf)){$X=$null}}
";

/// Quotes a path for a native command line. Windows paths never contain `"`,
/// and the paths quoted here never end in `\`, so this is exact MSVC quoting.
pub(in super::super) const QUOTE: &str = "function Q($path){'\"'+$path+'\"'}\n";

/// Runs a native program through ProcessStartInfo (PS 5.1 turns native stderr into
/// terminating errors under $ErrorActionPreference='Stop'); returns its code and output.
/// Always included together with QUOTE.
pub(in super::super) const RUN: &str = r"function Run($exe,$line){$i=New-Object Diagnostics.ProcessStartInfo $exe,$line;$i.UseShellExecute=$false;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$p=[Diagnostics.Process]::Start($i);$e=$p.StandardError.ReadToEndAsync();$o=$p.StandardOutput.ReadToEnd();$p.WaitForExit();@{Code=$p.ExitCode;Text=$o+$e.Result}}
";

/// $F (as entered) to a full path: `~`, `~/x`, `~\x` and relative paths are under the profile.
pub(super) const FOLDER: &str = r"$H=$env:USERPROFILE
if($F -eq '~'){$F=$H}elseif($F.StartsWith('~/') -or $F.StartsWith('~\')){$F=[IO.Path]::Combine($H,$F.Substring(2))}elseif(-not [IO.Path]::IsPathRooted($F)){$F=[IO.Path]::Combine($H,$F)}
";

pub(super) const PROBE: &str = r"'os=Windows'
'arch='+$env:PROCESSOR_ARCHITECTURE
";

pub(super) const FOLDER_OK: &str = r"if(Test-Path -LiteralPath $F -PathType Container){'folder=ok'}else{'folder=missing'}
";

/// Runs the current agent with $L as its argument line; 127 = not installed.
pub(super) const AGENT: &str = r"if(-not $X){exit 127}
$i=New-Object Diagnostics.ProcessStartInfo $X,$L
$i.UseShellExecute=$false
$p=[Diagnostics.Process]::Start($i)
$p.WaitForExit()
exit $p.ExitCode
";

pub(super) const INSTALLED: &str = "if($X){exit 0}\nexit 1\n";

/// Copies stdin byte-exact to $R\$U through native curl.exe (a file:// upload):
/// .NET stdin reads in PS 5.1 hang under Windows OpenSSH. The URI percent-encodes
/// the path (Hangul, spaces). Exit code = curl's.
pub(super) const UPLOAD: &str = r"New-Item -ItemType Directory -Force -Path (Join-Path $R 'versions')|Out-Null
$i=New-Object Diagnostics.ProcessStartInfo (Join-Path $env:SystemRoot 'System32\curl.exe'),('-sS -T - '+(Q ([Uri](Join-Path $R $U)).AbsoluteUri))
$i.UseShellExecute=$false
$p=[Diagnostics.Process]::Start($i)
$p.WaitForExit()
exit $p.ExitCode
";

pub(super) const REMOVE: &str = r"if($X){if((Run $X ('stop --data '+(Q $D)+' --json')).Code -ne 0){exit 1}}
if(Test-Path -LiteralPath $R){Remove-Item -LiteralPath $R -Recurse -Force}
";

pub(super) const DEPLOY: &str = r#"if(-not(Test-Path -LiteralPath $F -PathType Container)){exit 1}
if([IO.Path]::GetFullPath($F).TrimEnd('\') -eq $H.TrimEnd('\')){'state=home_folder';exit 0}
$VS=Join-Path $R 'versions'
New-Item -ItemType Directory -Force -Path $VS|Out-Null
$stale=@('.download-*','.staging-*');if(-not $UPLOADED){$stale+='.upload-*'}
foreach($n in $stale){Get-ChildItem -LiteralPath $VS -Force -Filter $n|Remove-Item -Recurse -Force}
$SHORT=$SHA.Substring(0,8)
$DEST="versions\$V-$SHORT"
function Offline{(Run $X ('status --json --data '+(Q $D))).Text -match '"status": *"offline"'}
function Start-Remote{$r=Run $X ('start --remote --data '+(Q $D)+' --json');if($r.Code -eq 0){"state=ready version=$V";exit 0};if($r.Text -match 'remote_service_breakaway_denied'){'state=breakaway_denied';exit 0};exit 1}
$CUR=if(Test-Path -LiteralPath $C){[IO.File]::ReadAllText($C).Trim()}else{''}
if($X -and $CUR -eq $DEST){if(Offline){Start-Remote};"state=ready version=$V";exit 0}
if($X -and -not(Offline)){$RUNNING=$CUR.Substring(9);"state=busy version=$($RUNNING.Substring(0,$RUNNING.LastIndexOf('-')))";exit 0}
$A=Join-Path $VS ".download-$SHORT"
$CURL=Join-Path $env:SystemRoot 'System32\curl.exe'
if($UPLOADED){$A=Join-Path $R $UPLOADED}elseif($URLQ -eq '' -or -not(Test-Path -LiteralPath $CURL)){'state=need_upload';exit 0}elseif((Run $CURL ('-fsSL -o '+(Q $A)+' '+$URLQ)).Code -ne 0){Remove-Item -LiteralPath $A -Force -ErrorAction SilentlyContinue;'state=need_upload';exit 0}
if((Get-FileHash -Algorithm SHA256 -LiteralPath $A).Hash -ne $SHA){Remove-Item -LiteralPath $A -Force;'state=need_upload';exit 0}
$TO=Join-Path $R $DEST
if(-not(Test-Path -LiteralPath $TO)){$ST=Join-Path $VS ".staging-$SHORT";New-Item -ItemType Directory -Path $ST|Out-Null;if((Run (Join-Path $env:SystemRoot 'System32\tar.exe') ('-xf '+(Q $A)+' -C '+(Q $ST))).Code -ne 0){exit 1};if((Get-Content -Raw -LiteralPath (Join-Path $ST 'native-agent-manifest.json')|ConvertFrom-Json).version -ne $V){exit 1};Move-Item -LiteralPath $ST -Destination $TO}
Remove-Item -LiteralPath $A -Force
$T=Join-Path $R 'current.tmp'
[IO.File]::WriteAllText($T,$DEST)
if(Test-Path -LiteralPath $C){[IO.File]::Replace($T,$C,$null)}else{[IO.File]::Move($T,$C)}
Get-ChildItem -LiteralPath $VS -Force|Where-Object{$_.FullName -ne $TO}|Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$X=Join-Path $TO 'butler-agent.exe'
Start-Remote
"#;

/// A long script sent on stdin behind a short encoded loader (cmd lines are
/// limited to 8191 chars). `body` is ASCII: stdin is decoded with the OEM code page.
pub(in super::super) fn script(body: &str) -> super::Remote {
    super::Remote {
        command: encoded_command(&format!(
            "{PRELUDE}$s=[Console]::In.ReadToEnd()\n& ([scriptblock]::Create($s))\n"
        )),
        stdin: body.as_bytes().to_vec(),
    }
}
