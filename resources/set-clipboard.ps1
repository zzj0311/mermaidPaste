param(
  [Parameter(Mandatory = $true)]
  [string]$Png,

  [Parameter(Mandatory = $false)]
  [string]$Emf,

  [Parameter(Mandatory = $false)]
  [string]$SvgPath
)

# ---------------------------------------------------------------------------
# Places PNG (CF_DIB) + optional EMF (CF_ENHMETAFILE) + optional SVG file
# (CF_HDROP, plus a registered "image/svg+xml" format) onto the Windows
# clipboard atomically.
#
# Electron's clipboard API only supports CF_DIB, so for the EMF/SVG path we
# must use Win32 via inline C#. We do the whole transaction in a single
# OpenClipboard/EmptyClipboard/CloseClipboard window so every format lands
# together (Office/Visio pick based on format priority).
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class Clip {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint RegisterClipboardFormatW(string name);

  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr GetEnhMetaFileW(string file);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GlobalLock(IntPtr h);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GlobalUnlock(IntPtr h);

  public const uint CF_ENHMETAFILE = 14;
  public const uint CF_DIB = 8;
  public const uint CF_HDROP = 15;
  public const uint GMEM_MOVEABLE = 0x0002;
  public const uint GMEM_ZEROINIT = 0x0040;
  public const uint GHND = GMEM_MOVEABLE | GMEM_ZEROINIT;

  // DROPFILES header is 20 bytes when packed (DWORD + 2*LONG + 2*BOOL).
  public const int DROPFILES_SIZE = 20;
}
"@ -ReferencedAssemblies System.Drawing

function New-HGlobal {
  param([byte[]]$bytes)

  $len = $bytes.Length
  $hMem = [Clip]::GlobalAlloc([Clip]::GHND, [UIntPtr]::new([uint64]$len))
  if ($hMem -eq [IntPtr]::Zero) { throw "GlobalAlloc failed (len=$len)" }

  $ptr = [Clip]::GlobalLock($hMem)
  if ($ptr -eq [IntPtr]::Zero) { throw "GlobalLock failed" }
  try {
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $len)
  } finally {
    [Clip]::GlobalUnlock($hMem) | Out-Null
  }
  return $hMem
}

function Write-Dib {
  param([string]$pngPath)

  # Convert PNG -> BMP -> strip BITMAPFILEHEADER -> GlobalAlloc HGLOBAL -> CF_DIB
  $bmp = [System.Drawing.Bitmap]::FromFile($pngPath)
  try {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bytes = $ms.ToArray()
    $ms.Dispose()
  } finally {
    $bmp.Dispose()
  }

  # BITMAPFILEHEADER is 14 bytes; CF_DIB expects data starting at BITMAPINFOHEADER.
  $dibLen = $bytes.Length - 14
  $dib = New-Object byte[] $dibLen
  [System.Array]::Copy($bytes, 14, $dib, 0, $dibLen)

  $hMem = New-HGlobal -bytes $dib
  $set = [Clip]::SetClipboardData([Clip]::CF_DIB, $hMem)
  if ($set -eq [IntPtr]::Zero) { throw "SetClipboardData(CF_DIB) failed" }
}

function Write-Emf {
  param([string]$emfPath)

  $h = [Clip]::GetEnhMetaFileW($emfPath)
  if ($h -eq [IntPtr]::Zero) { throw "GetEnhMetaFileW failed for $emfPath" }

  # Clipboard takes ownership of the handle; we MUST NOT call DeleteEnhMetaFile.
  $set = [Clip]::SetClipboardData([Clip]::CF_ENHMETAFILE, $h)
  if ($set -eq [IntPtr]::Zero) { throw "SetClipboardData(CF_ENHMETAFILE) failed" }
}

function Write-Hdrop {
  param([string]$filePath)

  # Layout:
  #   DROPFILES header (20 bytes, we set pFiles=20, fWide=1)
  #   UTF-16LE file path terminated by a single null
  #   An extra UTF-16 null (list terminator)
  $full = (Resolve-Path $filePath).Path
  $pathBytes = [System.Text.Encoding]::Unicode.GetBytes($full + [char]0)
  $listTerm = [System.Text.Encoding]::Unicode.GetBytes([string][char]0)

  $total = [Clip]::DROPFILES_SIZE + $pathBytes.Length + $listTerm.Length
  $buf = New-Object byte[] $total

  # DROPFILES {
  #   DWORD pFiles;     // offset to file list
  #   POINT pt;         // drop coords (2x LONG)
  #   BOOL  fNC;        // non-client area (BOOL = 4-byte int)
  #   BOOL  fWide;      // Unicode
  # }
  # Write pFiles = 20 at offset 0, fWide = 1 at offset 16.
  [System.BitConverter]::GetBytes([int][Clip]::DROPFILES_SIZE).CopyTo($buf, 0)
  [System.BitConverter]::GetBytes([int]1).CopyTo($buf, 16)
  [System.Array]::Copy($pathBytes, 0, $buf, [Clip]::DROPFILES_SIZE, $pathBytes.Length)
  [System.Array]::Copy($listTerm, 0, $buf, [Clip]::DROPFILES_SIZE + $pathBytes.Length, $listTerm.Length)

  $hMem = New-HGlobal -bytes $buf
  $set = [Clip]::SetClipboardData([Clip]::CF_HDROP, $hMem)
  if ($set -eq [IntPtr]::Zero) { throw "SetClipboardData(CF_HDROP) failed" }
}

function Write-RegisteredSvg {
  param([string]$filePath)

  # Also publish the raw SVG bytes under the registered MIME format. Some
  # apps (browsers, a few graphics tools) pull the SVG directly from the
  # clipboard without going through a file drop.
  $fmt = [Clip]::RegisterClipboardFormatW("image/svg+xml")
  if ($fmt -eq 0) { throw "RegisterClipboardFormatW(image/svg+xml) failed" }

  $bytes = [System.IO.File]::ReadAllBytes($filePath)
  $hMem = New-HGlobal -bytes $bytes
  $set = [Clip]::SetClipboardData($fmt, $hMem)
  if ($set -eq [IntPtr]::Zero) { throw "SetClipboardData(image/svg+xml) failed" }
}

# Retry briefly: another app may be holding the clipboard for a few ms.
$opened = $false
for ($i = 0; $i -lt 10; $i++) {
  if ([Clip]::OpenClipboard([IntPtr]::Zero)) { $opened = $true; break }
  Start-Sleep -Milliseconds 50
}
if (-not $opened) { throw "OpenClipboard failed" }

try {
  [Clip]::EmptyClipboard() | Out-Null

  # Order matters for pasters that honour format priority: highest-fidelity
  # (EMF) first, then the SVG file drop, then the registered SVG mime, then
  # the DIB fallback for Word/PPT/etc.
  if ($Emf -and (Test-Path $Emf)) {
    Write-Emf -emfPath (Resolve-Path $Emf).Path
  }

  if ($SvgPath -and (Test-Path $SvgPath)) {
    Write-Hdrop -filePath $SvgPath
    Write-RegisteredSvg -filePath $SvgPath
  }

  Write-Dib -pngPath (Resolve-Path $Png).Path
} finally {
  [Clip]::CloseClipboard() | Out-Null
}
