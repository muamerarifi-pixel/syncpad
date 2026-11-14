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
New-Item -ItemType Directory -Force -Path (Join-Path $androidDir 'res\drawable-nodpi') | Out-Null
Copy-Item (Join-Path $root 'public\icons\icon-192.png') (Join-Path $androidDir 'res\mipmap-xxhdpi\ic_launcher.png') -Force
Copy-Item (Join-Path $root 'public\icons\icon-192.png') (Join-Path $androidDir 'res\mipmap-xxhdpi\ic_launcher_round.png') -Force
Copy-Item (Join-Path $root 'public\icons\icon-512.png') (Join-Path $androidDir 'res\mipmap-xxxhdpi\ic_launcher.png') -Force
Copy-Item (Join-Path $root 'public\icons\icon-512.png') (Join-Path $androidDir 'res\mipmap-xxxhdpi\ic_launcher_round.png') -Force

# Build adaptive icon foreground (centered inside 66dp safe zone, soft-feathered into adaptive background)
Add-Type -AssemblyName System.Drawing
$fgOut = Join-Path $androidDir 'res\drawable-nodpi\ic_launcher_fg.png'
$srcBmp = [System.Drawing.Bitmap]::new((Join-Path $root 'public\icons\icon-512.png'))
$dstBmp = [System.Drawing.Bitmap]::new(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($dstBmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($srcBmp, [System.Drawing.Rectangle]::new(66, 66, 380, 380), [System.Drawing.Rectangle]::new(44, 44, 424, 424), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$srcBmp.Dispose()
$rect = [System.Drawing.Rectangle]::new(0, 0, 512, 512)
$bd = $dstBmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] (512 * 512 * 4)
[System.Runtime.InteropServices.Marshal]::Copy($bd.Scan0, $bytes, 0, $bytes.Length)
$feather = 26.0
for ($y = 0; $y -lt 512; $y++) {
  $dy = [Math]::Min($y - 66, 445 - $y)
  for ($x = 0; $x -lt 512; $x++) {
    $dx = [Math]::Min($x - 66, 445 - $x)
    $edge = [Math]::Min($dx, $dy)
    $i = (($y * 512) + $x) * 4
    if ($edge -le 0) {
      $bytes[$i + 3] = 0
      continue
    }
    $b = $bytes[$i]; $gch = $bytes[$i + 1]; $r = $bytes[$i + 2]; $a = $bytes[$i + 3]
    # Isolate the green cloud + subtle drop shadow cleanly from the mint background gradient
    $chroma = $gch - $r
    $darkness = 222 - (($r * 0.45) + ($b * 0.55))
    $t1 = ($chroma - 29.0) / 22.0
    $t2 = ($darkness - 8.0) / 26.0
    $keep = [Math]::Max($t1, $t2)
    if ($keep -le 0.0) {
      $bytes[$i + 3] = 0
      continue
    }
    if ($keep -gt 1.0) { $keep = 1.0 }
    if ($edge -lt $feather) { $keep *= ($edge / $feather) }
    $bytes[$i + 3] = [byte]([Math]::Round($a * $keep))
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $bd.Scan0, $bytes.Length)
$dstBmp.UnlockBits($bd)
$dstBmp.Save($fgOut, [System.Drawing.Imaging.ImageFormat]::Png)
$dstBmp.Dispose()

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
if (Test-Path "$outApk.idsig") { Remove-Item "$outApk.idsig" -Force }

$sizeKb = [Math]::Round((Get-Item $outApk).Length / 1KB, 1)
Write-Output "Built & signed $outApk ($sizeKb KB)"
