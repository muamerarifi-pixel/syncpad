# SyncPad - adds "SyncPad" to the Windows "Send to" menu.
# Started from the one-line command SyncPad copies for you (Settings > "Send to").

function Install-SyncPad([string]$Key) {
  $ErrorActionPreference = 'Stop'
  try { $Host.UI.RawUI.WindowTitle = 'SyncPad setup' } catch {}
  try {
    $parts = "$Key".Split('~')
    if ($parts.Count -ne 4) { throw 'The setup command is incomplete. Copy it again from SyncPad > Settings.' }
    foreach ($p in $parts) { if ($p -notmatch '^[A-Za-z0-9_-]{6,64}$') { throw 'The setup command is damaged. Copy it again from SyncPad > Settings.' } }

    $base = '__ORIGIN__'
    $dir = Join-Path $env:APPDATA 'SyncPad'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $utf8 = New-Object Text.UTF8Encoding $false
    $utf8Bom = New-Object Text.UTF8Encoding $true

    Write-Host ''
    Write-Host ' Setting up "Send to SyncPad"...' -ForegroundColor Cyan

    $cfg = [ordered]@{ base = $base; space = $parts[0]; token = $parts[1]; device = $parts[2]; secret = $parts[3]; name = ('{0} (Send to)' -f $env:COMPUTERNAME) }
    [IO.File]::WriteAllText((Join-Path $dir 'config.json'), (ConvertTo-Json -InputObject $cfg -Compress), $utf8)

    $send = @'
__SEND_PS1__
'@
    $sendPath = Join-Path $dir 'send.ps1'
    [IO.File]::WriteAllText($sendPath, $send, $utf8Bom)

    $ico = Join-Path $dir 'syncpad.ico'
    try {
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
      (New-Object Net.WebClient).DownloadFile($base + '/icons/syncpad.ico', $ico)
    } catch {}

    # register this computer as a SyncPad device and test the connection
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $ps -NoProfile -ExecutionPolicy Bypass -File $sendPath 'syncpad-check'
    if ($LASTEXITCODE -ne 0) { throw 'Could not connect to SyncPad.' }

    $sendTo = [Environment]::GetFolderPath('SendTo')
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path $sendTo 'SyncPad.lnk'))
    $lnk.TargetPath = $ps
    $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $sendPath + '"'
    $lnk.WorkingDirectory = $dir
    $lnk.Description = 'Send to SyncPad'
    if (Test-Path -LiteralPath $ico) { $lnk.IconLocation = $ico + ',0' }
    $lnk.WindowStyle = 1
    $lnk.Save()

    # the setup command holds this computer's key - remove it from the Run box history
    try {
      $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU'
      if (Test-Path $k) {
        $props = Get-ItemProperty -Path $k
        $list = [string]$props.MRUList
        foreach ($n in @($props.PSObject.Properties | Where-Object { $_.Name -match '^[a-z]$' })) {
          if ([string]$n.Value -like '*sendto.ps1*') {
            Remove-ItemProperty -Path $k -Name $n.Name
            $list = $list.Replace($n.Name, '')
          }
        }
        Set-ItemProperty -Path $k -Name MRUList -Value $list
      }
    } catch {}

    Write-Host ''
    Write-Host ' Done! "SyncPad" is now in your Send to menu.' -ForegroundColor Green
    Write-Host ' Right-click any file > Send to > SyncPad'
    Write-Host ' (Windows 11: right-click > Show more options > Send to > SyncPad)'
    Write-Host ''
    Start-Sleep -Seconds 8
  } catch {
    Write-Host ''
    Write-Host (' Setup did not finish: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    Read-Host ' Press Enter to close' | Out-Null
  }
}
