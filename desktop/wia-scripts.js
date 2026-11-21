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
 *   스캔은 모든 WIA 스캐너 드라이버가 지원하는 BMP 로 받고, WIA.ImageProcess 의 Convert 필터로 PNG(무손실)로 바꾼다.
 *   (변환이 실패하면 BMP 그대로 둔다.) */

const COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $script:Utf8)
$script:Out.AutoFlush = $true

function Emit($obj) {
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

const LIST_DEVICES_PS1 = String.raw`# AutoCroper: WIA scanner list
param([switch]$NoConnect)
` + COMMON + String.raw`
try {
  $dm = New-Object -ComObject WIA.DeviceManager
} catch {
  Emit @{ ok = $false; stage = 'manager'; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
  exit 0
}

try {
  $list = @()
  foreach ($di in $dm.DeviceInfos) {
    try {
      if ($di.Type -ne 1) { continue }
      $id = [string]$di.DeviceID
      $name = [string](Get-PropValue $di.Properties 7 '')
      if (-not $name) { $name = [string](Get-PropValue $di.Properties 4 '') }
      $feeder = $false
      $flatbed = $true
      $caps = $null
      if (-not $NoConnect) {
        try {
          $dev = $di.Connect()
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
  Emit @{ ok = $true; devices = $list }
} catch {
  Emit @{ ok = $false; stage = 'enum'; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
}
exit 0
`;

const SCAN_PS1 = String.raw`# AutoCroper: WIA scan
param([string]$JobFile)
` + COMMON + String.raw`
$FMT_BMP = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
$FMT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
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

function Save-Page($img, [int]$n) {
  $png = Join-Path $script:OutDir ('page_{0:D3}.png' -f $n)
  try {
    if ([string]$img.FormatID -eq $FMT_PNG) {
      $img.SaveFile($png)
    } else {
      $ip = New-Object -ComObject WIA.ImageProcess
      $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
      $ip.Filters.Item(1).Properties.Item('FormatID').Value = $FMT_PNG
      $conv = $ip.Apply($img)
      $conv.SaveFile($png)
    }
    return @{ file = [IO.Path]::GetFileName($png); format = 'png' }
  } catch {
    if (Test-Path -LiteralPath $png) { Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue }
    $bmp = Join-Path $script:OutDir ('page_{0:D3}.bmp' -f $n)
    $img.SaveFile($bmp)
    return @{ file = [IO.Path]::GetFileName($bmp); format = 'bmp' }
  }
}

$page = 0
try {
  $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $deviceId = [string]$job.deviceId
  $source = [string]$job.source
  $dpi = [int]$job.dpi
  $color = [string]$job.color
  $script:OutDir = [string]$job.outDir
  $maxPages = [int]$job.maxPages
  if ($maxPages -lt 1) { $maxPages = 1 }
  $feed = ($source -eq 'feeder')

  $dm = New-Object -ComObject WIA.DeviceManager
  $dev = $null
  foreach ($di in $dm.DeviceInfos) {
    if ([string]$di.DeviceID -eq $deviceId) { $dev = $di.Connect(); break }
  }
  if ($null -eq $dev) {
    Emit @{ type = 'error'; stage = 'connect'; hresult = '0x80210015'; message = 'device not found' }
    exit 0
  }

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
  if ($null -ne $hMax -and $hMax -gt 0) { $hOk = Set-Prop $item.Properties 6152 $hMax }
  if ((-not $hOk) -and $null -ne $hCalc) { $hOk = Set-Prop $item.Properties 6152 $hCalc }

  Emit @{ type = 'scanning'; dpi = $xres; extent = ($wOk -and $hOk) }

  while ($page -lt $maxPages) {
    if ($feed -and $page -gt 0) {
      $st = Get-PropValue $dev.Properties 3087 $null
      if ($null -ne $st -and (([int]$st -band 1) -eq 0)) { break }
    }
    $img = $null
    try {
      $img = $item.Transfer($FMT_BMP)
    } catch {
      $hr = Hex (Get-HResult $_)
      if ($feed -and $page -gt 0 -and $hr -eq $PAPER_EMPTY) { break }
      throw
    }
    if ($null -eq $img) { break }
    $page++
    $saved = Save-Page $img $page
    Emit @{ type = 'page'; page = $page; file = $saved.file; format = $saved.format }
    $img = $null
    if (-not $feed) { break }
  }
  Emit @{ type = 'done'; pages = $page }
} catch {
  Emit @{ type = 'error'; stage = 'scan'; pages = $page; hresult = (Hex (Get-HResult $_)); message = (Get-ErrMessage $_) }
}
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

module.exports = { LIST_DEVICES_PS1, SCAN_PS1, PARSE_CHECK_PS1, scriptBytes };
