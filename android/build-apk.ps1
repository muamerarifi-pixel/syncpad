$ErrorActionPreference = 'Stop'

if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
  $candidates = @(
    'C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot',
    'C:\Users\Asus\.gemini\antigravity\scratch\jdk17'
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c 'bin\java.exe')) { $env:JAVA_HOME = $c; break }
  }
}

$root = Split-Path -Parent $PSScriptRoot
$androidDir = $PSScriptRoot
$buildDir = Join-Path $androidDir 'build'
$sdk = 'C:\Users\Asus\AppData\Local\Android\Sdk'
$bt = Join-Path $sdk 'build-tools\36.1.0'
$platformJar = Join-Path $sdk 'platforms\android-36\android.jar'
$keystore = Join-Path $androidDir 'syncpad-signing.jks'
$outApk = Join-Path $root 'public\syncpad.apk'

New-Item -ItemType Directory -Force -Path (Join-Path $androidDir 'res\mipmap-xxhdpi') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $androidDir 'res\mipmap-xxxhdpi') | Out-Null
Copy-Item (Join-Path $root 'public\icons\icon-192.png') (Join-Path $androidDir 'res\mipmap-xxhdpi\ic_launcher.png') -Force
Copy-Item (Join-Path $root 'public\icons\icon-512.png') (Join-Path $androidDir 'res\mipmap-xxxhdpi\ic_launcher.png') -Force

if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
$genDir = Join-Path $buildDir 'gen'
$objDir = Join-Path $buildDir 'obj'
$dexDir = Join-Path $buildDir 'dex'
$resZip = Join-Path $buildDir 'res.zip'
New-Item -ItemType Directory -Force -Path $genDir, $objDir, $dexDir | Out-Null

# 1. Compile resources with aapt2
& (Join-Path $bt 'aapt2.exe') compile --dir (Join-Path $androidDir 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

# 2. Link resources + manifest into base APK + R.java
$unalignedApk = Join-Path $buildDir 'app-unaligned.apk'
& (Join-Path $bt 'aapt2.exe') link `
  -o $unalignedApk `
  -I $platformJar `
  --manifest (Join-Path $androidDir 'AndroidManifest.xml') `
  --java $genDir `
  $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

# 3. Compile Java sources (target 17)
$javaFiles = @(Get-ChildItem -Path (Join-Path $androidDir 'src'), $genDir -Filter '*.java' -Recurse | ForEach-Object { $_.FullName })
& javac -source 11 -target 11 -classpath $platformJar -d $objDir @javaFiles
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

# 4. Convert .class files to classes.dex with d8
$classFiles = @(Get-ChildItem -Path $objDir -Filter '*.class' -Recurse | ForEach-Object { $_.FullName })
& (Join-Path $bt 'd8.bat') --min-api 26 --lib $platformJar --output $dexDir @classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

# 5. Add classes.dex into unaligned APK
& (Join-Path $env:JAVA_HOME 'bin\jar.exe') uf $unalignedApk -C $dexDir classes.dex
if ($LASTEXITCODE -ne 0) { throw 'jar uf failed' }

# 6. Zipalign
$alignedApk = Join-Path $buildDir 'app-aligned.apk'
& (Join-Path $bt 'zipalign.exe') -f 4 $unalignedApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

# 7. Ensure signing keystore exists and sign APK with apksigner
if (-not (Test-Path $keystore)) {
  & keytool -genkeypair -v -keystore $keystore -storepass syncpad123 -keypass syncpad123 `
    -alias syncpad -keyalg RSA -keysize 2048 -validity 10000 `
    -dname "CN=SyncPad, OU=App, O=SyncPad, L=Local, ST=Local, C=XK" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}

& (Join-Path $bt 'apksigner.bat') sign `
  --ks $keystore `
  --ks-pass pass:syncpad123 `
  --ks-key-alias syncpad `
  --key-pass pass:syncpad123 `
  --out $outApk `
  $alignedApk
if ($LASTEXITCODE -ne 0) { throw 'apksigner sign failed' }

& (Join-Path $bt 'apksigner.bat') verify --print-certs $outApk
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify failed' }

$sizeKb = [Math]::Round((Get-Item $outApk).Length / 1KB, 1)
Write-Output "Built & signed $outApk ($sizeKb KB)"
