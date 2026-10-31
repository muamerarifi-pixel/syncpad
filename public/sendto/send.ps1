# SyncPad - "Send to" uploader for Windows (Windows PowerShell 5.1+)
# Explorer runs this with the selected files and folders as arguments.
# Folders are zipped first. Settings live in %APPDATA%\SyncPad\config.json.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'Continue'
try { $Host.UI.RawUI.WindowTitle = 'SyncPad' } catch {}

$Dir = Join-Path $env:APPDATA 'SyncPad'
$CfgPath = Join-Path $Dir 'config.json'
$Chunk = 1048576
$MaxFile = 200MB

function Stop-WithError([string]$msg) {
  Write-Host ''
  Write-Host $msg -ForegroundColor Red
  Write-Host ''
  Read-Host 'Press Enter to close' | Out-Null
  exit 1
}

if (-not (Test-Path -LiteralPath $CfgPath)) { Stop-WithError 'SyncPad is not set up on this computer yet. Open SyncPad > Settings > "Send to" on this Windows PC.' }
$Cfg = Get-Content -LiteralPath $CfgPath -Raw | ConvertFrom-Json

function Save-Config {
  $json = $Cfg | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($CfgPath, $json, (New-Object Text.UTF8Encoding $false))
}

Add-Type -AssemblyName System.Net.Http
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Http = New-Object System.Net.Http.HttpClient
$Http.Timeout = [TimeSpan]::FromMinutes(5)

# One API call with retries. $makeContent is a script block, because HttpClient disposes content after sending.
function Invoke-Api([string]$method, [string]$path, [scriptblock]$makeContent) {
  for ($try = 0; $try -lt 5; $try++) {
    $url = '{0}/api/s/{1}/{2}' -f $Cfg.base, $Cfg.space, $path
    $req = New-Object System.Net.Http.HttpRequestMessage ((New-Object System.Net.Http.HttpMethod $method), $url)
    [void]$req.Headers.TryAddWithoutValidation('x-k', [string]$Cfg.token)
    [void]$req.Headers.TryAddWithoutValidation('x-d', [string]$Cfg.device)
    [void]$req.Headers.TryAddWithoutValidation('x-ds', [string]$Cfg.secret)
    if ($makeContent) { $req.Content = & $makeContent }
    try {
      $res = $Http.SendAsync($req).GetAwaiter().GetResult()
    } catch {
      Start-Sleep -Seconds ([Math]::Min(8, 1 + 2 * $try))
      continue
    }
    $code = [int]$res.StatusCode
    $body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if ($code -eq 409) {
      # the space link was renewed (a device was removed) - this computer is still trusted, take the new key
      $j = $null
      try { $j = $body | ConvertFrom-Json } catch {}
      if ($j -and $j.token) { $Cfg.token = [string]$j.token; Save-Config; continue }
    }
    if ($code -eq 403) {
      if ($body -match 'revoked') { Stop-WithError 'This computer was removed from SyncPad. To use "Send to" again, set it up again from SyncPad settings.' }
      Stop-WithError 'SyncPad did not accept this computer. Set up "Send to" again from SyncPad settings.'
    }
    if ($code -eq 507) { Stop-WithError 'Your SyncPad storage is full. Delete some files in SyncPad and try again.' }
    if ($code -ge 500 -or $code -eq 429) { Start-Sleep -Seconds ([Math]::Min(8, 1 + 2 * $try)); continue }
    return [pscustomobject]@{ Code = $code; Body = $body }
  }
  Stop-WithError 'Could not reach SyncPad. Check your internet connection and try again.'
}

function New-Id([int]$n) {
  $b = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  return (([Convert]::ToBase64String($b)) -replace '[^A-Za-z0-9]', '').Substring(0, $n)
}

function Send-Sync($ops) {
  $payload = @{ since = 2000000000; name = [string]$Cfg.name; ops = @($ops) }
  $json = ConvertTo-Json -InputObject $payload -Depth 8 -Compress
  $r = Invoke-Api 'POST' 'sync' { New-Object System.Net.Http.StringContent ($json, [Text.Encoding]::UTF8, 'application/json') }
  if ($r.Code -ne 200) { Stop-WithError ('SyncPad answered with an error ({0}).' -f $r.Code) }
  return ($r.Body | ConvertFrom-Json)
}

$Types = @{
  jpg = 'image/jpeg'; jpeg = 'image/jpeg'; png = 'image/png'; gif = 'image/gif'; webp = 'image/webp'; bmp = 'image/bmp'
  heic = 'image/heic'; heif = 'image/heif'; avif = 'image/avif'; svg = 'image/svg+xml'; tif = 'image/tiff'; tiff = 'image/tiff'
  mp4 = 'video/mp4'; m4v = 'video/mp4'; mov = 'video/quicktime'; webm = 'video/webm'; mkv = 'video/x-matroska'; avi = 'video/x-msvideo'
  mp3 = 'audio/mpeg'; m4a = 'audio/mp4'; wav = 'audio/wav'; ogg = 'audio/ogg'; opus = 'audio/ogg'; flac = 'audio/flac'; aac = 'audio/aac'
  pdf = 'application/pdf'; txt = 'text/plain'; md = 'text/markdown'; csv = 'text/csv'; json = 'application/json'; html = 'text/html'; htm = 'text/html'
  zip = 'application/zip'; rar = 'application/vnd.rar'; '7z' = 'application/x-7z-compressed'; apk = 'application/vnd.android.package-archive'
  doc = 'application/msword'; docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  xls = 'application/vnd.ms-excel'; xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ppt = 'application/vnd.ms-powerpoint'; pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

function Get-MimeType([string]$path) {
  $ext = [IO.Path]::GetExtension($path).TrimStart('.').ToLowerInvariant()
  if ($ext -and $Types.ContainsKey($ext)) { return $Types[$ext] }
  try {
    $ct = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\.' + $ext) -ErrorAction Stop).'Content Type'
    if ($ct -match '^[\w.+-]+/[\w.+-]+$') { return [string]$ct }
  } catch {}
  return ''
}

# Small preview picture for photos, like the app makes (440 px, JPEG)
function Get-Thumb([string]$path, [string]$type) {
  if ($type -notmatch '^image/(jpeg|png|gif|bmp|tiff)$') { return $null }
  try {
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($path)
    try {
      if ($img.PropertyIdList -contains 274) {
        $o = $img.GetPropertyItem(274).Value[0]
        if ($o -eq 3) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
        elseif ($o -eq 6) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
        elseif ($o -eq 8) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
      }
      $w = $img.Width
      $h = $img.Height
      $k = [Math]::Min(1.0, 440.0 / [Math]::Max($w, $h))
      $tw = [Math]::Max(1, [int][Math]::Round($w * $k))
      $th = [Math]::Max(1, [int][Math]::Round($h * $k))
      $bmp = New-Object System.Drawing.Bitmap ($tw, $th)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.Clear([System.Drawing.Color]::White)
      $g.DrawImage($img, 0, 0, $tw, $th)
      $g.Dispose()
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
      $ep = New-Object System.Drawing.Imaging.EncoderParameters (1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]72)
      $ms = New-Object IO.MemoryStream
      $bmp.Save($ms, $codec, $ep)
      $bmp.Dispose()
      $data = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($ms.ToArray())
      if ($data.Length -gt 190000) { return $null }
      return @{ thumb = $data; w = $w; h = $h }
    } finally { $img.Dispose() }
  } catch { return $null }
}

function Send-File([string]$path, [string]$name) {
  $size = (Get-Item -LiteralPath $path).Length
  if ($size -gt $MaxFile) {
    Write-Host ('  Skipped {0}: bigger than 200 MB' -f $name) -ForegroundColor Yellow
    return $false
  }
  $id = New-Id 16
  $type = Get-MimeType $path
  $count = [int][Math]::Ceiling($size / $Chunk)
  $fs = [IO.File]::OpenRead($path)
  try {
    for ($i = 0; $i -lt $count; $i++) {
      $len = [int][Math]::Min($Chunk, $size - [long]$i * $Chunk)
      $buf = New-Object byte[] $len
      $read = 0
      while ($read -lt $len) {
        $n = $fs.Read($buf, $read, $len - $read)
        if ($n -le 0) { throw 'The file changed while it was being sent.' }
        $read += $n
      }
      $pct = [int](100 * ($i + 1) / [Math]::Max(1, $count))
      Write-Progress -Activity ('Sending ' + $name) -Status ('{0}%' -f $pct) -PercentComplete $pct
      $r = Invoke-Api 'PUT' ('file/{0}/{1}' -f $id, $i) { New-Object System.Net.Http.ByteArrayContent (, $buf) }
      if ($r.Code -ne 200) { throw ('Upload failed ({0}).' -f $r.Code) }
    }
  } finally { $fs.Dispose() }
  Write-Progress -Activity ('Sending ' + $name) -Completed

  $data = @{ name = $name; size = $size; type = $type }
  $t = Get-Thumb $path $type
  if ($t) { $data.thumb = $t.thumb; $data.w = $t.w; $data.h = $t.h }
  $now = [long](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds)
  $op = @{ id = $id; kind = 'file'; deleted = $false; baseRev = 0; created = $now; data = $data }
  $res = Send-Sync @($op)
  $ack = @($res.acks)[0]
  if (-not $ack -or -not $ack.ok) { throw ('SyncPad could not save it ({0}).' -f $(if ($ack) { $ack.err } else { 'no answer' })) }
  return $true
}

# --- setup check: register this computer and test the connection
if ($args.Count -ge 1 -and $args[0] -eq 'syncpad-check') {
  $null = Send-Sync @()
  Write-Host 'Connected to SyncPad.' -ForegroundColor Green
  exit 0
}

$items = @($args | Where-Object { $_ })
if ($items.Count -eq 0) {
  Write-Host 'Right-click files in File Explorer and choose Send to > SyncPad.'
  Start-Sleep -Seconds 4
  exit 0
}

Write-Host ''
Write-Host (' Sending {0} item(s) to SyncPad...' -f $items.Count) -ForegroundColor Cyan
Write-Host ''
$ok = 0
$failed = 0
foreach ($p in $items) {
  $temp = $null
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      $folder = Get-Item -LiteralPath $p
      Write-Host ('  Zipping folder {0}...' -f $folder.Name)
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $temp = Join-Path ([IO.Path]::GetTempPath()) ('syncpad-' + (New-Id 8) + '.zip')
      [IO.Compression.ZipFile]::CreateFromDirectory($folder.FullName, $temp)
      $sent = Send-File $temp ($folder.Name + '.zip')
    } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
      $sent = Send-File $p ([IO.Path]::GetFileName($p))
    } else {
      Write-Host ('  Not found: {0}' -f $p) -ForegroundColor Yellow
      $sent = $false
    }
    if ($sent) { $ok++; Write-Host ('  OK  {0}' -f ([IO.Path]::GetFileName($p))) -ForegroundColor Green } else { $failed++ }
  } catch {
    $failed++
    Write-Host ('  Failed  {0}: {1}' -f ([IO.Path]::GetFileName($p)), $_.Exception.Message) -ForegroundColor Red
  } finally {
    if ($temp -and (Test-Path -LiteralPath $temp)) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}

Write-Host ''
if ($failed -eq 0) {
  Write-Host (' Done - {0} sent. Open SyncPad on any device to see it.' -f $ok) -ForegroundColor Green
  Start-Sleep -Seconds 2
  exit 0
}
Write-Host (' {0} sent, {1} not sent.' -f $ok, $failed) -ForegroundColor Yellow
Read-Host 'Press Enter to close' | Out-Null
exit 1
