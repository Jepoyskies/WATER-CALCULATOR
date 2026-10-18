#Requires -Version 5.1
<#
    Downloads everything phone-app\build.ps1 needs to make the APK.

    Nothing here installs system-wide and nothing needs administrator rights -
    it all unpacks into one folder. Roughly 300 MB, so on a slow connection
    this takes a while; it can be re-run safely and picks up where it left off.

    What it fetches, and why:

      JDK 21          javac compiles MainActivity.java, keytool makes the
                      signing key, and d8/apksigner are Java programs that
                      need a runtime
      build-tools     aapt2 (turns the manifest and resources into an APK),
                      d8 (Java bytecode -> DEX), zipalign, apksigner
      platform 34     android.jar - the API surface javac compiles against

    Usage:
        powershell -ExecutionPolicy Bypass -File phone-app\get-toolchain.ps1
#>

param(
    [string]$DevTools = "C:\Users\gametech\devtools"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Dl  = Join-Path $DevTools "dl"
$Sdk = Join-Path $DevTools "sdk"

New-Item -ItemType Directory -Force -Path $Dl, $Sdk | Out-Null

function Say($m)  { Write-Host "  $m" }
function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

function Get-BigFile($name, $url, $dest) {
    if ((Test-Path $dest) -and (Test-Path "$dest.ok")) { Say "$name already downloaded"; return }

    for ($try = 1; $try -le 60; $try++) {
        if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
        Say "$name attempt $try"

        & curl.exe -sS --fail --retry 3 --retry-delay 5 --retry-all-errors `
            --max-time 3000 -o $dest $url 2>&1 |
            Select-Object -Last 2 | ForEach-Object { Say $_ }

        if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 5MB)) {
            New-Item -ItemType File -Path "$dest.ok" -Force | Out-Null
            Say ("$name ok - {0:N1} MB" -f ((Get-Item $dest).Length / 1MB))
            return
        }
    }
    throw "Gave up downloading $name"
}

# ---------------------------------------------------------------- downloads

Step "Downloading the JDK (about 180 MB)"

# BellSoft was the fastest mirror from this machine; swap the URL if it is slow
Get-BigFile "JDK 21" `
    "https://download.bell-sw.com/java/21.0.5+11/bellsoft-jdk21.0.5+11-windows-amd64.zip" `
    (Join-Path $Dl "jdk.zip")

Step "Downloading the Android build tools (about 58 MB)"
Get-BigFile "build-tools" `
    "https://dl.google.com/android/repository/build-tools_r34-windows.zip" `
    (Join-Path $Dl "build-tools.zip")

Step "Downloading the Android platform (about 60 MB)"
Get-BigFile "platform" `
    "https://dl.google.com/android/repository/platform-34-ext7_r03.zip" `
    (Join-Path $Dl "platform.zip")

# ---------------------------------------------------------------- unpacking

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Expand-Into($zip, $dest) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
}

Step "Unpacking the JDK"
if (-not (Test-Path (Join-Path $DevTools "jdk"))) {
    $stage = Join-Path $Dl "jdk-unpacked"
    Expand-Into (Join-Path $Dl "jdk.zip") $stage
    New-Item -ItemType Directory -Force -Path (Join-Path $DevTools "jdk") | Out-Null
    Get-ChildItem $stage -Directory | ForEach-Object {
        Move-Item $_.FullName (Join-Path $DevTools ("jdk\" + $_.Name))
    }
    Remove-Item $stage -Recurse -Force
    Say "unpacked"
} else { Say "already unpacked" }

Step "Unpacking the Android SDK"

# build-tools_r34-windows.zip contains a single "android-14" folder; the SDK
# expects it to be called 34.0.0
if (-not (Test-Path (Join-Path $Sdk "build-tools\34.0.0"))) {
    $stage = Join-Path $Dl "bt-unpacked"
    Expand-Into (Join-Path $Dl "build-tools.zip") $stage
    $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path (Join-Path $Sdk "build-tools") | Out-Null
    Move-Item $inner.FullName (Join-Path $Sdk "build-tools\34.0.0")
    Remove-Item $stage -Recurse -Force
    Say "unpacked -> sdk\build-tools\34.0.0"
} else { Say "already unpacked" }

# platform-34-ext7_r03.zip contains an "android-34-ext7" folder
if (-not (Test-Path (Join-Path $Sdk "platforms\android-34\android.jar"))) {
    $stage = Join-Path $Dl "plat-unpacked"
    Expand-Into (Join-Path $Dl "platform.zip") $stage
    $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path (Join-Path $Sdk "platforms") | Out-Null
    Move-Item $inner.FullName (Join-Path $Sdk "platforms\android-34")
    Remove-Item $stage -Recurse -Force
    Say "unpacked -> sdk\platforms\android-34"
} else { Say "already unpacked" }

# ------------------------------------------------------------------- summary

Step "Ready"

$javac = Get-ChildItem (Join-Path $DevTools "jdk\*\bin\javac.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
if ($javac) { Say "javac       $($javac.FullName)" } else { Say "javac       NOT FOUND" }
$copyDex = Join-Path $Sdk "build-tools\34.0.0\d8.bat"
if (Test-Path $copyDex) { Say "d8          $copyDex" } else { Say "d8          NOT FOUND" }
$jar = Join-Path $Sdk "platforms\android-34\android.jar"
if (Test-Path $jar) { Say "android.jar $jar" } else { Say "android.jar NOT FOUND" }

Write-Host ""
Write-Host "Now run:  powershell -ExecutionPolicy Bypass -File phone-app\build.ps1" -ForegroundColor Green
