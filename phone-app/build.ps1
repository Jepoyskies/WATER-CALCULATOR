#Requires -Version 5.1
<#
    Builds Water Calc into an installable Android APK.

    It drives the Android SDK command line tools directly - aapt2, d8,
    zipalign, apksigner - instead of going through Gradle. Gradle would pull
    down several hundred more megabytes, and this project is small enough that
    the four steps are easy to follow:

        aapt2 compile    resources                    -> compiled resources
        aapt2 link       manifest + resources + assets -> an APK with no code
        javac + d8       MainActivity.java             -> classes.dex
        zipalign, sign   classes.dex goes in, then the APK gets signed

    Runs on Windows and on Linux (which is how GitHub Actions builds it), so
    the same script produces the same APK in both places.

        powershell -ExecutionPolicy Bypass -File phone-app\build.ps1
        pwsh phone-app/build.ps1
#>

param(
    # Where a JDK and an Android SDK were unpacked by get-toolchain.ps1.
    # Leave empty to use JAVA_HOME / ANDROID_HOME from the environment.
    [string]$DevTools = "",

    [string]$OutDir = "",

    [string]$VersionName = "1.0",
    [int]$VersionCode = 1,

    # Produce the APK without signing it (it cannot be installed like that).
    [switch]$SkipSign
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Here = $PSScriptRoot
if (-not $Here) { $Here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ProjectRoot = Split-Path -Parent $Here

$isWindowsHost = ($env:OS -eq "Windows_NT")
$exe = if ($isWindowsHost) { ".exe" } else { "" }

function Say($msg)  { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Boom($msg) { Write-Host ""; Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

function FirstExisting($paths) {
    foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
    return ""
}

# ---------------------------------------------------------------- toolchain

Step "Looking for the toolchain"

# --- Java -------------------------------------------------------------------
# javac compiles MainActivity, keytool makes the signing key, and d8 and
# apksigner are Java programs that need a runtime to run under.
$javaHome = ""

if ($DevTools) {
    $candidate = Get-ChildItem (Join-Path $DevTools "jdk") -Directory -ErrorAction SilentlyContinue |
                 Where-Object { Test-Path (Join-Path $_.FullName "bin\javac$exe") } |
                 Sort-Object Name -Descending | Select-Object -First 1
    if ($candidate) { $javaHome = $candidate.FullName }
}

if (-not $javaHome -and $env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\javac$exe"))) {
    $javaHome = $env:JAVA_HOME
}

if (-not $javaHome) {
    $onPath = Get-Command "javac$exe" -ErrorAction SilentlyContinue
    if ($onPath) { $javaHome = Split-Path -Parent (Split-Path -Parent $onPath.Source) }
}

if (-not $javaHome) { Boom "No JDK found. Set JAVA_HOME, or run phone-app/get-toolchain.ps1 first." }

$JavaHome = $javaHome
$env:JAVA_HOME = $javaHome
Say "java        $javaHome"

# --- Android SDK ------------------------------------------------------------
$sdkRoot = ""

if ($DevTools -and (Test-Path (Join-Path $DevTools "sdk"))) { $sdkRoot = Join-Path $DevTools "sdk" }
if (-not $sdkRoot -and $env:ANDROID_HOME)       { $sdkRoot = $env:ANDROID_HOME }
if (-not $sdkRoot -and $env:ANDROID_SDK_ROOT)   { $sdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $sdkRoot -and $env:HOME) {
    $guess = Join-Path $env:HOME "Android\Sdk"
    if (Test-Path $guess) { $sdkRoot = $guess }
}
if (-not $sdkRoot) { Boom "No Android SDK found. Set ANDROID_HOME, or run phone-app/get-toolchain.ps1 first." }

# --- build-tools ------------------------------------------------------------
# 34.0.0 is what get-toolchain installs; anything else on the machine will do.
$preferred = Join-Path $sdkRoot "build-tools\34.0.0"
$buildTools = ""

if (Test-Path (Join-Path $preferred "aapt2$exe")) {
    $buildTools = $preferred
} else {
    $found = Get-ChildItem (Join-Path $sdkRoot "build-tools") -Directory -ErrorAction SilentlyContinue |
             Where-Object { Test-Path (Join-Path $_.FullName "aapt2$exe") } |
             Sort-Object Name -Descending | Select-Object -First 1
    if ($found) { $buildTools = $found.FullName }
}

if (-not $buildTools) { Boom "No Android build-tools with aapt2 under $sdkRoot\build-tools"
}
Say "build-tools $buildTools"

$aapt2     = Join-Path $buildTools "aapt2$exe"
$zipalign  = Join-Path $buildTools "zipalign$exe"
$apksigner = Join-Path $buildTools $(if ($isWindowsHost) { "apksigner.bat" } else { "apksigner" })
$d8        = Join-Path $buildTools $(if ($isWindowsHost) { "d8.bat" } else { "d8" })

foreach ($tool in @($aapt2, $zipalign, $apksigner, $d8)) {
    if (-not (Test-Path $tool)) { Boom "Missing $tool" }
}

# --- platform ---------------------------------------------------------------
# android.jar is the API surface javac compiles against and aapt2 links with.
$androidJar = Join-Path $sdkRoot "platforms\android-34\android.jar"

if (-not (Test-Path $androidJar)) {
    $found = Get-ChildItem (Join-Path $sdkRoot "platforms") -Directory -ErrorAction SilentlyContinue |
             Where-Object { Test-Path (Join-Path $_.FullName "android.jar") } |
             Sort-Object Name -Descending | Select-Object -First 1
    if ($found) { $androidJar = Join-Path $found.FullName "android.jar" }
}

if (-not (Test-Path $androidJar)) { Boom "No android.jar under $sdkRoot\platforms" }
Say "android.jar $androidJar"

$javac   = Join-Path $javaHome "bin\javac$exe"
$jar     = Join-Path $javaHome "bin\jar$exe"
$keytool = Join-Path $javaHome "bin\keytool$exe"
foreach ($tool in @($javac, $jar, $keytool)) {
    if (-not (Test-Path $tool)) { Boom "Missing $tool" }
}

# ------------------------------------------------------------------- layout

if (-not $OutDir) { $OutDir = Join-Path $Here "dist" }

$AppName    = "WaterCalc"
$Build      = Join-Path $Here "build"
$Assets     = Join-Path $Build "assets"
$ResZip     = Join-Path $Build "resources.zip"
$Classes    = Join-Path $Build "classes"
$DexDir     = Join-Path $Build "dex"
$ClassesJar = Join-Path $Build "classes.jar"
$Unsigned   = Join-Path $Build "app-unsigned.apk"
$Aligned    = Join-Path $Build "app-aligned.apk"
$ApkOut     = Join-Path $OutDir "$AppName-$VersionName.apk"
$Keystore   = Join-Path $Here "keystore\watercalc.p12"
$StorePass  = "watercalc"

if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Build, $Assets, $Classes, $DexDir, $OutDir | Out-Null

# ------------------------------------------------------- copy the web app in

Step "Packaging the web app"

$www = Join-Path $Assets "www"
New-Item -ItemType Directory -Force -Path $www | Out-Null

$webFiles = @("index.html", "style.css", "parser.js", "store.js", "app.js", "manifest.webmanifest")
foreach ($name in $webFiles) {
    $src = Join-Path $ProjectRoot $name
    if (-not (Test-Path $src)) { Boom "Missing $name in $ProjectRoot" }
    Copy-Item $src $www -Force
}

# The icons the web manifest points at
$iconSrc = Join-Path $ProjectRoot "icons"
if (Test-Path $iconSrc) {
    $iconDst = Join-Path $www "icons"
    New-Item -ItemType Directory -Force -Path $iconDst | Out-Null
    Get-ChildItem $iconSrc -File | Copy-Item -Destination $iconDst -Force
}

# sw.js is deliberately left out. The files are already on the device, so a
# service worker would only duplicate them - and index.html already skips
# registering one when it finds itself running inside the app.
Say "packed $((Get-ChildItem $www -Recurse -File).Count) web files"

# ------------------------------------------------------------ compile + link

Step "Compiling resources"

& $aapt2 compile --dir (Join-Path $Here "android\res") -o $ResZip
if ($LASTEXITCODE -ne 0) { Boom "aapt2 compile failed" }
Say "ok"

Step "Linking the APK"

& $aapt2 link `
    -o $Unsigned `
    -I $androidJar `
    --manifest (Join-Path $Here "android\AndroidManifest.xml") `
    -R $ResZip `
    -A $Assets `
    --min-sdk-version 21 `
    --target-sdk-version 34 `
    --version-code $VersionCode `
    --version-name $VersionName `
    --auto-add-overlay

if ($LASTEXITCODE -ne 0) { Boom "aapt2 link failed" }
Say ("ok  ({0:N0} KB before the code goes in)" -f ((Get-Item $Unsigned).Length / 1KB))

# --------------------------------------------------------------- java -> dex

Step "Compiling Java"

$javaSources = @(Get-ChildItem (Join-Path $Here "android\src") -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($javaSources.Count -eq 0) { Boom "No Java sources found." }

# --release 8 keeps the bytecode at a level every Android version understands.
& $javac -encoding UTF-8 --release 8 -nowarn `
    -classpath $androidJar `
    -d $Classes `
    $javaSources

if ($LASTEXITCODE -ne 0) { Boom "javac failed" }
Say "ok  ($($javaSources.Count) file)"

Step "Building classes.dex"

Push-Location $Build
& $jar cf $ClassesJar -C $Classes .
$jarCode = $LASTEXITCODE
Pop-Location
if ($jarCode -ne 0) { Boom "jar failed" }

& $d8 --release --min-api 21 --lib $androidJar --output $DexDir $ClassesJar
if ($LASTEXITCODE -ne 0) { Boom "d8 failed" }

$dex = Join-Path $DexDir "classes.dex"
if (-not (Test-Path $dex)) { Boom "d8 produced no classes.dex" }
Say ("ok  ({0:N0} KB)" -f ((Get-Item $dex).Length / 1KB))

Step "Adding the code to the APK"

# An APK is a zip file, so the dex simply goes in alongside the assets.
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

$apk = [System.IO.Compression.ZipFile]::Open($Unsigned, "Update")
try {
    $existing = $apk.GetEntry("classes.dex")
    if ($existing) { $existing.Delete() }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $apk, $dex, "classes.dex",
        [System.IO.Compression.CompressionLevel]::Optimal)
} finally {
    $apk.Dispose()
}
Say "ok"

Step "Aligning"

# Android can only memory-map resources.arsc if it starts on a 4 byte boundary.
& $zipalign -f -p 4 $Unsigned $Aligned
if ($LASTEXITCODE -ne 0) { Boom "zipalign failed" }
Say "ok"

# ------------------------------------------------------------------ signing

if ($SkipSign) {
    Copy-Item $Aligned $ApkOut -Force
    Write-Host ""
    Write-Host "Signed nothing - $ApkOut is not installable as it is." -ForegroundColor Yellow
    exit 0
}

Step "Signing"

if (-not (Test-Path $Keystore)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Keystore) | Out-Null
    Say "creating a signing key (it lives in phone-app/keystore so that updates work)"
    & $keytool -genkeypair `
        -keystore $Keystore `
        -storetype PKCS12 `
        -alias watercalc `
        -keyalg RSA -keysize 2048 -validity 10950 `
        -storepass $StorePass -keypass $StorePass `
        -dname "CN=WaterCalc,OU=WaterDelivery,O=WaterCalc,L=Philippines,C=PH"
    if ($LASTEXITCODE -ne 0) { Boom "keytool failed" }
}

# v1 covers Android 4.4 and older launchers, v2 covers Android 7 and up, v3
# lets the key be rotated later. Signing with all three costs nothing.
& $apksigner sign `
    --ks $Keystore `
    --ks-type PKCS12 `
    --ks-pass "pass:$StorePass" `
    --key-pass "pass:$StorePass" `
    --v1-signing-enabled true `
    --v2-signing-enabled true `
    --v3-signing-enabled true `
    --out $ApkOut `
    $Aligned

if ($LASTEXITCODE -ne 0) { Boom "apksigner failed" }

Step "Verifying"

& $apksigner verify --print-certs $ApkOut | Select-Object -First 4 | ForEach-Object { Say $_ }
if ($LASTEXITCODE -ne 0) { Boom "the signed APK did not verify" }

$size = (Get-Item $ApkOut).Length
$hash = (Get-FileHash $ApkOut -Algorithm SHA256).Hash.ToLower()

Write-Host ""
Write-Host "Built: $ApkOut" -ForegroundColor Green
Write-Host ("       {0:N2} MB   sha256 {1}" -f ($size / 1MB), $hash.Substring(0, 16))
Write-Host ""
