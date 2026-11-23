//! Application discovery: one hidden PowerShell pass that collects Start-menu
//! apps (with their AppUserModelIDs, like Get-StartApps), Store packages and
//! their executables, Start Menu / desktop shortcuts, App Paths, and the
//! default browser / music player. The script is fixed text with no user input.

use super::model::RawDiscovery;

pub const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$start = @(Get-StartApps | ForEach-Object { [ordered]@{ Name = [string]$_.Name; AppID = [string]$_.AppID } })

# Store packages, only those with a Start-menu entry (keeps the scan fast).
$fams = @{}
foreach ($s in $start) { $id = $s.AppID; $i = $id.IndexOf('!'); if ($i -gt 0) { $fams[$id.Substring(0, $i).ToLower()] = $true } }
$packages = @(Get-AppxPackage | Where-Object { $_.PackageFamilyName -and $fams.ContainsKey($_.PackageFamilyName.ToLower()) } | ForEach-Object {
  $apps = @()
  $manifest = Join-Path $_.InstallLocation 'AppxManifest.xml'
  if ($_.InstallLocation -and (Test-Path -LiteralPath $manifest)) {
    try {
      [xml]$x = Get-Content -LiteralPath $manifest -Raw
      foreach ($a in @($x.Package.Applications.Application)) { $apps += [ordered]@{ id = [string]$a.Id; exe = [string]$a.Executable } }
    } catch {}
  }
  [ordered]@{ family = [string]$_.PackageFamilyName; location = [string]$_.InstallLocation; apps = $apps }
})

$sh = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory')
)
$shortcuts = @(foreach ($d in $dirs) {
  if ($d -and (Test-Path -LiteralPath $d)) {
    Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -File | ForEach-Object {
      try { $l = $sh.CreateShortcut($_.FullName); [ordered]@{ name = $_.BaseName; path = $_.FullName; target = [string]$l.TargetPath; args = [string]$l.Arguments } } catch {}
    }
  }
})

$appPaths = @(foreach ($root in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths') {
  Get-ChildItem -LiteralPath $root | ForEach-Object {
    $p = $_.GetValue('')
    if ($p) { [ordered]@{ exe = [string]$_.PSChildName; path = ([string]$p).Trim('"') } }
  }
})

$pf = $env:ProgramW6432; if (-not $pf) { $pf = $env:ProgramFiles }
$folders = [ordered]@{
  ProgramFiles = $pf; ProgramFilesX86 = ${env:ProgramFiles(x86)}; Windows = $env:windir
  System = [Environment]::GetFolderPath('System'); SystemX86 = [Environment]::GetFolderPath('SystemX86')
  LocalAppData = $env:LOCALAPPDATA; AppData = $env:APPDATA; ProgramData = $env:ProgramData
}

function Get-DefaultHandler([string[]]$keys) {
  foreach ($k in $keys) {
    $progId = (Get-ItemProperty -LiteralPath $k -Name ProgId).ProgId
    if (-not $progId) { continue }
    $o = [ordered]@{ progId = [string]$progId }
    $aumid = (Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\$progId\Application" -Name AppUserModelID).AppUserModelID
    if ($aumid) { $o.aumid = [string]$aumid }
    $cmd = (Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command").GetValue('')
    if ($cmd) { $o.command = [string]$cmd }
    return $o
  }
  return $null
}
$defaults = [ordered]@{}
$b = Get-DefaultHandler @(
  'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice',
  'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoiceLatest')
if ($b) { $defaults.browser = $b }
$m = Get-DefaultHandler @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mp3\UserChoice',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mp3\UserChoiceLatest')
if ($m) { $defaults.music = $m }

[ordered]@{ start = $start; packages = $packages; shortcuts = $shortcuts; appPaths = $appPaths; folders = $folders; defaults = $defaults } |
  ConvertTo-Json -Depth 6 -Compress
"#;

/// Parse the scan's stdout (tolerates a UTF-8 BOM and leading noise).
pub fn parse(stdout: &str) -> Result<RawDiscovery, String> {
    let s = stdout.trim_start_matches('\u{feff}');
    let start = s.find('{').ok_or("app scan returned no data")?;
    serde_json::from_str(&s[start..]).map_err(|e| format!("couldn't read the app scan: {e}"))
}

#[cfg(windows)]
pub fn run(script_dir: &std::path::Path) -> Result<RawDiscovery, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // A file (not -EncodedCommand): plainer for antivirus heuristics.
    std::fs::create_dir_all(script_dir).map_err(|e| e.to_string())?;
    let path = script_dir.join("discover-apps.ps1");
    std::fs::write(&path, format!("\u{feff}{SCRIPT}")).map_err(|e| e.to_string())?;

    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("couldn't start PowerShell: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return Err("the app scan took too long".into());
            }
        }
    }
    let out = reader.join().unwrap_or_default();
    parse(&String::from_utf8_lossy(&out))
}

#[cfg(target_os = "linux")]
pub fn run(_script_dir: &std::path::Path) -> Result<RawDiscovery, String> {
    let native = super::desktop::scan();
    if native.is_empty() {
        return Err("no apps found in any applications folder".into());
    }
    Ok(RawDiscovery { native, ..Default::default() })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn run(_script_dir: &std::path::Path) -> Result<RawDiscovery, String> {
    Err("app discovery isn't supported on this OS".into())
}
