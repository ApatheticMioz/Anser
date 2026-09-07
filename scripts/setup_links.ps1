# setup_links.ps1 - Creates global symbolic links for Antigravity and Claude Code configuration
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$geminiSrc = Join-Path $repoRoot "GEMINI.md"
$claudeSrc = Join-Path $repoRoot "CLAUDE.md"

if (-not (Test-Path $geminiSrc) -or -not (Test-Path $claudeSrc)) {
    Write-Error "Could not find GEMINI.md or CLAUDE.md at repo root: $repoRoot"
    exit 1
}

# Win32 CreateSymbolicLink binding supporting SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE (0x2)
$Signature = @"
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CreateSymbolicLink(string lpSymlinkFileName, string lpTargetFileName, int dwFlags);
"@
$Win32 = Add-Type -MemberDefinition $Signature -Name "Win32Symlink" -Namespace "Win32Native" -PassThru

function New-NativeSymlink {
    param(
        [Parameter(Mandatory=$true)][string]$LinkPath,
        [Parameter(Mandatory=$true)][string]$TargetPath
    )
    if (Test-Path -LiteralPath $LinkPath) {
        Remove-Item -LiteralPath $LinkPath -Force
    }
    # dwFlags: 0x2 = SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE (File)
    $success = [Win32Native.Win32Symlink]::CreateSymbolicLink($LinkPath, $TargetPath, 2)
    if (-not $success) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        # Fallback to standard 0x0 if 0x2 is not supported
        $success = [Win32Native.Win32Symlink]::CreateSymbolicLink($LinkPath, $TargetPath, 0)
        if (-not $success) {
            throw "CreateSymbolicLink failed for $LinkPath -> $TargetPath with Win32 Error Code: $err"
        }
    }
}

$userProfile = $env:USERPROFILE
$geminiDst = Join-Path $userProfile ".gemini\GEMINI.md"
$claudeDst = Join-Path $userProfile ".claude\CLAUDE.md"
$geminiRuleDst = Join-Path $userProfile ".gemini\config\rules\00_hierarchical_avo.md"

# Ensure target directories exist
New-Item -ItemType Directory -Path (Split-Path $geminiDst) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $claudeDst) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $geminiRuleDst) -Force | Out-Null

# Create Windows symbolic links
Write-Host "Creating Windows symbolic links..."
New-NativeSymlink -LinkPath $geminiDst -TargetPath $geminiSrc
Write-Host "  -> Linked $geminiDst -> $geminiSrc"

New-NativeSymlink -LinkPath $claudeDst -TargetPath $claudeSrc
Write-Host "  -> Linked $claudeDst -> $claudeSrc"

New-NativeSymlink -LinkPath $geminiRuleDst -TargetPath $geminiSrc
Write-Host "  -> Linked $geminiRuleDst -> $geminiSrc"

# If WSL is available, also update WSL symlinks
try {
    $wslCheck = wsl.exe -e which bash 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Configuring WSL symlinks..."
        wsl.exe -e bash -c "/mnt/d/LLM_Ecosystem/scripts/wsl/setup_links.sh"
        Write-Host "  -> WSL symlinks configured."
    }
} catch {
    Write-Warning "WSL not reachable or error updating WSL symlinks: $_"
}

Write-Host "`nAll global Antigravity and Claude links are active and pointing to $repoRoot."
