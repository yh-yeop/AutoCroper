'use strict';
/* Windows 스캐너(WIA) 용 PowerShell 스크립트.
 * asar 안의 파일은 PowerShell 이 직접 실행할 수 없어서, 실행할 때마다 임시 폴더에 .ps1 로 써서 돌린다.
 * - 스크립트는 ASCII 만 쓴다 (Windows PowerShell 5.1 은 BOM 없는 .ps1 을 ANSI 로 읽는다; 그래도 BOM 을 붙여 쓴다).
 * - 결과는 stdout 에 한 줄에 JSON 하나씩(UTF-8, BOM 없음) 쓴다. 한국어 오류 문구는 scanner.js 가 HRESULT 로 고른다.
 * - 오류도 JSON 으로 쓰고 exit 0 으로 끝낸다. JSON 없이 0 이 아닌 코드로 끝나면 스크립트 자체(구문 · PowerShell)가 잘못된 것.
 *
 * WIA 값 (wiadef.h · WIA Automation)
 *   장치 종류 Type 1 = ScannerDeviceType
 *   장치 속성: 7 WIA_DIP_DEV_NAME, 4 WIA_DIP_DEV_DESC,
 *     3074/3075 WIA_DPS_HORIZONTAL/VERTICAL_BED_SIZE (1/1000 인치), 3076/3077 ..._SHEET_FEED_SIZE,
 *     3086 WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES (FEED 0x1, FLAT 0x2, DUP 0x4),
 *     3087 WIA_DPS_DOCUMENT_HANDLING_STATUS (FEED_READY 0x1),
 *     3088 WIA_DPS_DOCUMENT_HANDLING_SELECT (FEEDER 0x1, FLATBED 0x2), 3096 WIA_DPS_PAGES
 *   항목 속성: 4098 WIA_IPA_ITEM_NAME, 4103 WIA_IPA_DATATYPE (2 GRAYSCALE, 3 COLOR), 4104 WIA_IPA_DEPTH,
 *     6146 WIA_IPS_CUR_INTENT (1 COLOR, 2 GRAYSCALE, 4 TEXT), 6147/6148 WIA_IPS_XRES/YRES,
 *     6149/6150 WIA_IPS_XPOS/YPOS, 6151/6152 WIA_IPS_XEXTENT/YEXTENT
 *   형식 GUID: BMP {B96B3CAB-...}, PNG {B96B3CAF-...}, JPEG {B96B3CAE-...} (-0728-11D3-9D7B-0000F81EF32E)
 *   속도를 위해 드라이버가 JPEG 전송을 지원하면 JPEG 로 받고(스캐너 쪽에서 압축 → 전송량 약 1/10),
 *   아니면 BMP 로 받아 변환 없이 그대로 넘긴다(앱이 BMP 를 바로 연다).
 *   (변환이 실패하면 BMP 그대로 둔다.)
 *
 * 스크립트
 *   LIST_DEVICES_PS1 · SCAN_PS1: 한 번 실행하고 끝나는 예전 방식 (세션을 못 쓸 때의 대비책)
 *   SESSION_PS1: 앱이 켜져 있는 동안 계속 도는 PowerShell 하나. stdin 으로 한 줄에 JSON 명령 하나를 받고
 *     stdout 으로 한 줄에 JSON 이벤트 하나를 쓴다. DeviceManager 와 연결한 Device 를 DeviceID 별로 들고 있어서
 *     다음 스캔은 PowerShell 시작 · 장치 연결을 건너뛴다. 명령은 아래 SESSION_PS1 위 설명 참고. */

const COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $script:Utf8)
$script:Out.AutoFlush = $true

# Session mode: every event carries the id of the command it answers.
$script:CmdId = $null
function Emit($obj) {
  if ($null -ne $script:CmdId) { $obj['id'] = $script:CmdId }
  $script:Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 6))
}

function Hex($n) {
  if ($null -eq $n) { return $null }
  return ('0x{0:X8}' -f ([int64]$n -band [int64]4294967295))
}

function Get-HResult($err) {
  $e = $err
  if ($err -is [System.Management.Automation.ErrorRecord]) { $e = $err.Exception }
  $x = $e
  while ($null -ne $x) {
    if ($x -is [System.Runtime.InteropServices.COMException]) { return $x.ErrorCode }
    $x = $x.InnerException
  }
  $x = $e
  while ($null -ne $x.InnerException) { $x = $x.InnerException }
  return $x.HResult
}

function Get-ErrMessage($err) {
  $e = $err
  if ($err -is [System.Management.Automation.ErrorRecord]) { $e = $err.Exception }
  while ($null -ne $e.InnerException) { $e = $e.InnerException }
  return [string]$e.Message
}

function Find-Prop($props, [int]$id) {
  foreach ($p in $props) {
    if ($p.PropertyID -eq $id) { return $p }
  }
  return $null
}

function Get-PropValue($props, [int]$id, $default) {
  try {
    $p = Find-Prop $props $id
    if ($null -ne $p) { return $p.Value }
  } catch { }
  return $default
}
`;

// 연결이 끊겼거나 낡았다고 볼 수 있는 HRESULT: 세션이 캐시를 버리고 한 번 다시 연결해 다시 시도한다.
//   WIA OFFLINE · BUSY · ITEM_DELETED · DEVICE_COMMUNICATION · S_NO_DEVICE_AVAILABLE · ERROR_NOT_READY,
//   RPC_S_SERVER_UNAVAILABLE · RPC_S_CALL_FAILED · RPC_S_CALL_FAILED_DNE · RPC_E_DISCONNECTED · CO_E_OBJNOTCONNECTED
//   (WIA 서비스가 다시 시작되면 들고 있던 COM 개체가 RPC 오류를 낸다)
const STALE_CODES = [
  '0x80210005', '0x80210006', '0x80210009', '0x8021000A', '0x80210015', '0x80070015',
  '0x800706BA', '0x800706BE', '0x800706BF', '0x80010108', '0x800401FD'
];

// 장치 목록 (한 번 실행 · 세션 공용)
const LIST_FUNCS = String.raw`
# Scanner list. $cache (hashtable or $null) receives the connected Device objects by DeviceID.
function Get-DeviceList($dm, [bool]$connect, $cache) {
  $list = @()
  foreach ($di in $dm.DeviceInfos) {
    try {
      # 1 = scanner. Some drivers report 0 (unspecified); skip only camera (2) and video (3).
      if ($di.Type -eq 2 -or $di.Type -eq 3) { continue }
      $id = [string]$di.DeviceID
      $name = [string](Get-PropValue $di.Properties 7 '')
      if (-not $name) { $name = [string](Get-PropValue $di.Properties 4 '') }
      $feeder = $false
      $flatbed = $true
      $caps = $null
      if ($connect) {
        try {
          $dev = $di.Connect()
          if ($null -ne $cache) { $cache[$id] = $dev }
          $caps = Get-PropValue $dev.Properties 3086 $null
        } catch { }
      }
      if ($null -ne $caps) {
        $c = [int]$caps
        $feeder = (($c -band 1) -ne 0)
        $flatbed = ((($c -band 2) -ne 0) -or (($c -band 1) -eq 0))
      }
      $list += @{ id = $id; name = $name; feeder = $feeder; flatbed = $flatbed; caps = $caps }
    } catch { }
  }
  return ,$list
}
`;

const LIST_DEVICES_PS1 = String.raw`# AutoCroper: WIA scanner list
param([switch]$NoConnect)
` + COMMON + LIST_FUNCS + String.raw`
try {
  $dm = New-Object -ComObject WIA.DeviceManager
} catch {
  Emit @{ ok = $false; stage = 'manager'; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
  exit 0
}

try {
  $list = Get-DeviceList $dm (-not $NoConnect) $null
  Emit @{ ok = $true; devices = $list }
} catch {
  Emit @{ ok = $false; stage = 'enum'; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
}
exit 0
`;

// 스캔 (한 번 실행 · 세션 공용). Invoke-Scan 은 'scanning' · 'page' · 'done' 을 내고, 실패하면 throw 한다.
const SCAN_FUNCS = String.raw`
$FMT_BMP = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
$FMT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
$FMT_JPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$PAPER_EMPTY = '0x80210003'

function Set-Prop($props, [int]$id, $value) {
  try {
    $p = Find-Prop $props $id
    if ($null -eq $p) { return $false }
    $p.Value = $value
    return $true
  } catch {
    return $false
  }
}

function Get-Max($props, [int]$id) {
  try {
    $p = Find-Prop $props $id
    if ($null -ne $p -and $p.SubType -eq 1) { return [int]$p.SubTypeMax }
  } catch { }
  return $null
}

# Set a numeric property; if the driver rejects the value and lists allowed values, use the nearest one.
function Set-Nearest($props, [int]$id, [int]$value) {
  if (Set-Prop $props $id $value) { return $value }
  try {
    $p = Find-Prop $props $id
    if ($null -eq $p) { return $null }
    $cands = @()
    if ($p.SubType -eq 2) {
      foreach ($v in $p.SubTypeValues) { $cands += [int]$v }
    } elseif ($p.SubType -eq 1) {
      $min = [int]$p.SubTypeMin; $max = [int]$p.SubTypeMax
      $cands += [Math]::Max($min, [Math]::Min($max, $value))
    }
    $best = $null
    foreach ($v in $cands) {
      if ($null -eq $best -or [Math]::Abs($v - $value) -lt [Math]::Abs($best - $value)) { $best = $v }
    }
    if ($null -ne $best -and (Set-Prop $props $id $best)) { return $best }
  } catch { }
  return $null
}

function Save-Page($img, [string]$dir, [int]$n) {
  $fmt = ([string]$img.FormatID).ToUpper()
  $ext = 'bmp'
  if ($fmt -eq $FMT_JPEG) { $ext = 'jpg' } elseif ($fmt -eq $FMT_PNG) { $ext = 'png' }
  $out = Join-Path $dir ('page_{0:D3}.{1}' -f $n, $ext)
  $img.SaveFile($out)
  return @{ file = [IO.Path]::GetFileName($out); format = $ext }
}

# Fastest transfer format the driver advertises: JPEG > PNG > BMP
function Pick-Format($item) {
  $fmts = @()
  try { foreach ($f in $item.Formats) { $fmts += ([string]$f).ToUpper() } } catch { }
  if ($fmts -contains $FMT_JPEG) { return $FMT_JPEG }
  if ($fmts -contains $FMT_PNG) { return $FMT_PNG }
  return $FMT_BMP
}

# Scan area (flatbed): the top part of the bed, full width. full = 1, top2_3 = 2/3, top1_2 = 1/2 of the height.
function Scale-Area([int]$full, [string]$area) {
  if ($area -eq 'top2_3') { return [int][Math]::Floor($full * 2 / 3) }
  if ($area -eq 'top1_2') { return [int][Math]::Floor($full / 2) }
  return $full
}

function Connect-ById($dm, [string]$id) {
  foreach ($di in $dm.DeviceInfos) {
    if ([string]$di.DeviceID -eq $id) { return ,($di.Connect()) }
  }
  return $null
}

# Configure the scan item from $job (source, dpi, color, area, outDir, maxPages) and transfer the pages.
# $state.page counts saved pages (the caller reports it on error); $state.cached = device connection was reused.
function Invoke-Scan($dev, $job, $state) {
  $source = [string]$job.source
  $dpi = [int]$job.dpi
  $color = [string]$job.color
  $area = [string]$job.area
  $outDir = [string]$job.outDir
  $maxPages = [int]$job.maxPages
  if ($maxPages -lt 1) { $maxPages = 1 }
  $feed = ($source -eq 'feeder')
  if ($feed -or (-not $area)) { $area = 'full' }

  # Source (device level). Some drivers reject this; continue anyway.
  if ($feed) {
    [void](Set-Prop $dev.Properties 3088 1)
    [void](Set-Prop $dev.Properties 3096 1)
  } else {
    [void](Set-Prop $dev.Properties 3088 2)
  }

  # WIA 2.0 drivers seen through the automation layer may expose separate Flatbed / Feeder items.
  $item = $null
  $items = $dev.Items
  if ($items.Count -gt 1) {
    foreach ($it in $items) {
      $nm = [string](Get-PropValue $it.Properties 4098 '')
      if ($feed -and $nm -match 'feed|adf') { $item = $it; break }
      if ((-not $feed) -and $nm -match 'flat|platen|glass') { $item = $it; break }
    }
  }
  if ($null -eq $item) { $item = $items.Item(1) }

  $intent = 1; $dataType = 3; $depth = 24
  if ($color -eq 'gray') { $intent = 2; $dataType = 2; $depth = 8 }
  [void](Set-Prop $item.Properties 6146 $intent)
  [void](Set-Prop $item.Properties 4103 $dataType)
  [void](Set-Prop $item.Properties 4104 $depth)
  $xres = Set-Nearest $item.Properties 6147 $dpi
  $yres = Set-Nearest $item.Properties 6148 $dpi
  if ($null -eq $xres) { $xres = [int](Get-PropValue $item.Properties 6147 $dpi) }
  if ($null -eq $yres) { $yres = [int](Get-PropValue $item.Properties 6148 $dpi) }
  [void](Set-Prop $item.Properties 6149 0)
  [void](Set-Prop $item.Properties 6150 0)

  # Full scan area: the item's maximum extent, or the bed / feeder size (1/1000 inch) x dpi / 1000.
  # The area option keeps the full width and takes that fraction of the full height, from the top (YPOS 0).
  $wMax = Get-Max $item.Properties 6151
  $hMax = Get-Max $item.Properties 6152
  $bw = $null; $bh = $null
  if ($feed) {
    $bw = Get-PropValue $dev.Properties 3076 $null
    $bh = Get-PropValue $dev.Properties 3077 $null
  }
  if ($null -eq $bw -or [int]$bw -le 0) { $bw = Get-PropValue $dev.Properties 3074 $null }
  if ($null -eq $bh -or [int]$bh -le 0) { $bh = Get-PropValue $dev.Properties 3075 $null }
  $wCalc = $null; $hCalc = $null
  if ($null -ne $bw -and [int]$bw -gt 0) { $wCalc = [int][Math]::Floor([int]$bw * $xres / 1000) }
  if ($null -ne $bh -and [int]$bh -gt 0) { $hCalc = [int][Math]::Floor([int]$bh * $yres / 1000) }
  $wOk = $false; $hOk = $false
  if ($null -ne $wMax -and $wMax -gt 0) { $wOk = Set-Prop $item.Properties 6151 $wMax }
  if ((-not $wOk) -and $null -ne $wCalc) { $wOk = Set-Prop $item.Properties 6151 $wCalc }
  $hFull = $hMax
  if ($null -eq $hFull -or $hFull -le 0) { $hFull = $hCalc }
  $height = $null
  foreach ($hf in @($hMax, $hCalc)) {
    if ($hOk -or $null -eq $hf -or [int]$hf -le 0) { continue }
    $h = Scale-Area ([int]$hf) $area
    if (Set-Prop $item.Properties 6152 $h) { $hOk = $true; $height = $h; $hFull = [int]$hf }
  }
  if ((-not $hOk) -and $area -ne 'full' -and $null -ne $hFull -and [int]$hFull -gt 0) {
    $h = Set-Nearest $item.Properties 6152 (Scale-Area ([int]$hFull) $area)
    if ($null -ne $h) { $hOk = $true; $height = $h }
  }

  $xferFmt = Pick-Format $item
  Emit @{ type = 'scanning'; dpi = $xres; extent = ($wOk -and $hOk); format = $xferFmt; area = $area; height = $height; heightMax = $hFull; warm = ($state.cached -eq $true) }

  while ($state.page -lt $maxPages) {
    if ($feed -and $state.page -gt 0) {
      $st = Get-PropValue $dev.Properties 3087 $null
      if ($null -ne $st -and (([int]$st -band 1) -eq 0)) { break }
    }
    $img = $null
    try {
      $img = $item.Transfer($xferFmt)
    } catch {
      $hr = Hex (Get-HResult $_)
      if ($feed -and $state.page -gt 0 -and $hr -eq $PAPER_EMPTY) { break }
      # If the advertised format is rejected, retry once with BMP (first page only, so the feeder never pulls a sheet twice).
      if ($state.page -eq 0 -and $xferFmt -ne $FMT_BMP) {
        $xferFmt = $FMT_BMP
        $img = $item.Transfer($xferFmt)
      } else { throw }
    }
    if ($null -eq $img) { break }
    $state.page = $state.page + 1
    $saved = Save-Page $img $outDir $state.page
    Emit @{ type = 'page'; page = $state.page; file = $saved.file; format = $saved.format }
    $img = $null
    if (-not $feed) { break }
  }
  Emit @{ type = 'done'; pages = $state.page }
}
`;

const SCAN_PS1 = String.raw`# AutoCroper: WIA scan
param([string]$JobFile)
` + COMMON + SCAN_FUNCS + String.raw`
$state = @{ page = 0; cached = $false }
try {
  $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $dm = New-Object -ComObject WIA.DeviceManager
  $dev = Connect-ById $dm ([string]$job.deviceId)
  if ($null -eq $dev) {
    Emit @{ type = 'error'; stage = 'connect'; hresult = '0x80210015'; message = 'device not found' }
    exit 0
  }
  $null = Invoke-Scan $dev $job $state
} catch {
  Emit @{ type = 'error'; stage = 'scan'; pages = $state.page; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
}
exit 0
`;

/* 세션: 명령 (한 줄에 JSON 하나, 모든 명령에 숫자 id → 그 명령의 이벤트에 같은 id)
 *   {"cmd":"list"}                → {type:'list', ok, devices | hresult, message}   (목록을 읽으며 연결한 장치는 캐시)
 *   {"cmd":"warm","deviceId":...} → {type:'warm', ok, cached | hresult, message}    (연결해 캐시만 해 둔다)
 *   {"cmd":"scan", deviceId, source, dpi, color, area, outDir, maxPages}
 *                                 → 'scanning' · 'page'… · 'done' | 'error'  (+ 다시 연결할 때 'retry')
 *   {"cmd":"ping"}                → {type:'pong'}
 *   {"cmd":"quit"}                → {type:'bye'} 를 쓰고 exit 0. stdin 이 닫혀도(앱이 죽어도) exit 0.
 * 시작하면 먼저 {type:'ready'} 를 쓴다. stdin 은 UTF-8 로 읽는다(그래도 scanner.js 는 ASCII 로만 보낸다). */
const SESSION_PS1 = String.raw`# AutoCroper: WIA session (line-delimited JSON commands on stdin, events on stdout)
param()
` + COMMON + LIST_FUNCS + SCAN_FUNCS + String.raw`
$script:In = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $script:Utf8)
$script:Dm = $null
$script:Devices = @{}
$script:StaleCodes = @(` + STALE_CODES.map((c) => "'" + c + "'").join(', ') + String.raw`)

function Test-Stale([string]$hr) { return ($script:StaleCodes -contains $hr) }

function Get-Manager {
  if ($null -eq $script:Dm) { $script:Dm = New-Object -ComObject WIA.DeviceManager }
  return ,$script:Dm
}

# Forget connected devices; $all also drops the DeviceManager.
function Reset-Cache([bool]$all) {
  $script:Devices = @{}
  if ($all) { $script:Dm = $null }
}

# Cached Device for this DeviceID, or connect and cache it. $null if there is no such device.
function Get-Device([string]$id) {
  if ($script:Devices.ContainsKey($id)) { return ,$script:Devices[$id] }
  $dev = Connect-ById (Get-Manager) $id
  if ($null -ne $dev) { $script:Devices[$id] = $dev }
  return ,$dev
}

function Cmd-List($cmd) {
  $retried = $false
  while ($true) {
    $hadMgr = ($null -ne $script:Dm)
    try {
      $dm = Get-Manager
      $fresh = @{}
      $list = Get-DeviceList $dm $true $fresh
      $script:Devices = $fresh
      Emit @{ type = 'list'; ok = $true; devices = $list }
      return
    } catch {
      $hr = Hex (Get-HResult $_)
      $msg = Get-ErrMessage $_
      Reset-Cache $true
      if ($hadMgr -and (-not $retried)) { $retried = $true; continue }
      Emit @{ type = 'list'; ok = $false; stage = 'enum'; hresult = $hr; message = $msg }
      return
    }
  }
}

function Cmd-Warm($cmd) {
  $id = [string]$cmd.deviceId
  $retried = $false
  while ($true) {
    $hadMgr = ($null -ne $script:Dm)
    $cached = $script:Devices.ContainsKey($id)
    try {
      $dev = Get-Device $id
      if ($null -ne $dev) {
        # A cheap call on the cached object: throws if the connection is gone.
        [void]$dev.Properties.Count
        Emit @{ type = 'warm'; ok = $true; cached = $cached }
        return
      }
      if ($hadMgr -and (-not $retried)) { $retried = $true; Reset-Cache $true; continue }
      Emit @{ type = 'warm'; ok = $false; hresult = '0x80210015'; message = 'device not found' }
      return
    } catch {
      $hr = Hex (Get-HResult $_)
      $msg = Get-ErrMessage $_
      Reset-Cache $true
      if ($hadMgr -and (-not $retried)) { $retried = $true; continue }
      Emit @{ type = 'warm'; ok = $false; hresult = $hr; message = $msg }
      return
    }
  }
}

# On a stale-connection error before the first page: drop the cache, reconnect once and scan again.
function Cmd-Scan($cmd) {
  $id = [string]$cmd.deviceId
  $state = @{ page = 0; cached = $false }
  $retried = $false
  while ($true) {
    $hadMgr = ($null -ne $script:Dm)
    $state.cached = $script:Devices.ContainsKey($id)
    try {
      $dev = Get-Device $id
      if ($null -eq $dev) {
        if ($hadMgr -and (-not $retried)) {
          $retried = $true
          Reset-Cache $true
          Emit @{ type = 'retry'; stage = 'connect'; hresult = '0x80210015'; message = 'device not found' }
          continue
        }
        Emit @{ type = 'error'; stage = 'connect'; pages = 0; hresult = '0x80210015'; message = 'device not found' }
        return
      }
      $null = Invoke-Scan $dev $cmd $state
      return
    } catch {
      $hr = Hex (Get-HResult $_)
      $msg = Get-ErrMessage $_
      $stale = Test-Stale $hr
      if ($stale) { Reset-Cache $true }
      if ($stale -and $hadMgr -and (-not $retried) -and $state.page -eq 0) {
        $retried = $true
        Emit @{ type = 'retry'; stage = 'scan'; hresult = $hr; message = $msg }
        continue
      }
      Emit @{ type = 'error'; stage = 'scan'; pages = $state.page; hresult = $hr; message = $msg }
      return
    }
  }
}

# Create the DeviceManager up front so the first command does not pay for it.
try { $null = Get-Manager } catch { }
Emit @{ type = 'ready'; version = 1; pid = $PID; wia = ($null -ne $script:Dm) }

$quit = $false
while (-not $quit) {
  $line = $script:In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $script:CmdId = $null
  $cmd = $null
  try { $cmd = ConvertFrom-Json -InputObject $line } catch { $cmd = $null }
  if ($null -eq $cmd -or $null -eq $cmd.cmd) {
    Emit @{ type = 'error'; stage = 'command'; message = 'bad command' }
    continue
  }
  if ($null -ne $cmd.id) { $script:CmdId = $cmd.id }
  $name = [string]$cmd.cmd
  try {
    if ($name -eq 'list') { Cmd-List $cmd
    } elseif ($name -eq 'warm') { Cmd-Warm $cmd
    } elseif ($name -eq 'scan') { Cmd-Scan $cmd; [System.GC]::Collect()
    } elseif ($name -eq 'ping') { Emit @{ type = 'pong' }
    } elseif ($name -eq 'quit') { Emit @{ type = 'bye' }; $quit = $true
    } else { Emit @{ type = 'error'; stage = 'command'; message = ('unknown command: ' + $name) } }
  } catch {
    Emit @{ type = 'error'; stage = 'command'; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
  }
}
$script:CmdId = $null
exit 0
`;

// CI 용: 스크립트를 PowerShell 파서로 구문 검사만 한다. 인자: 검사할 .ps1 경로들 (-File 뒤에 하나씩)
const PARSE_CHECK_PS1 = String.raw`# AutoCroper: PowerShell syntax check
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths)
` + COMMON + String.raw`
$all = @()
foreach ($p in $Paths) {
  $tokens = $null; $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errs)
  foreach ($e in $errs) {
    $all += @{ file = [IO.Path]::GetFileName($p); line = $e.Extent.StartLineNumber; message = [string]$e.Message }
  }
}
Emit @{ ok = ($all.Count -eq 0); errors = $all }
exit 0
`;

// Windows PowerShell 5.1 이 확실히 UTF-8 로 읽도록 BOM 을 붙인다. 줄바꿈은 CRLF.
function scriptBytes(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')]);
}

module.exports = { LIST_DEVICES_PS1, SCAN_PS1, SESSION_PS1, PARSE_CHECK_PS1, STALE_CODES, scriptBytes };
