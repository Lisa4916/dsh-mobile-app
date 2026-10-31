# 逐点采样 MIUI 输入法窗口的 frame.top，得到键盘真实滑入曲线。
#
# 为什么用 dumpsys 而不是录屏：
#   本机 screenrecord 已坏（MTK c2.mtk.avc.encoder 起不来，ScreenRecord: failed，exit 235），
#   而 screencap 单帧要 1.2s，都采不到 280ms 的动画中间态。
#   但 `dumpsys window windows` 定向 grep 只要约 186ms，把系统动画减速 10 倍后
#   （动画拉长到约 2.8s），就能采到十几个真实中间点。
#
# 用法：先确保 App 在 DSH 主界面且键盘收起，然后
#   pwsh -File track-ime.ps1

param(
    [string]$Adb   = 'D:\AndroidDev\sdk\platform-tools\adb.exe',
    [string]$Device = '8PCE7LJB99VG7TRO',
    [int]$TapX = 525,
    [int]$TapY = 1402,
    [int]$Scale = 10
)

function Set-AnimationScale([int]$v) {
    foreach ($k in @('animator_duration_scale','transition_animation_scale','window_animation_scale')) {
        & $script:Adb -s $script:Device shell settings put global $k $v | Out-Null
    }
}

# 输入法窗口的 frame.top：收起时通常是 100（仅避开状态栏），弹出时上移到约 1530。
function Get-ImeTop {
    $raw = & $script:Adb -s $script:Device shell 'dumpsys window windows' 2>$null
    $inIme = $false
    foreach ($line in $raw) {
        if ($line -match 'Window\{[0-9a-f]+ u0 InputMethod\}') { $inIme = $true; continue }
        if ($inIme -and $line -match 'frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]') {
            return [int]$Matches[2]
        }
    }
    return -1
}

Set-AnimationScale $Scale
& $Adb -s $Device shell am force-stop com.dsh.remote | Out-Null
& $Adb -s $Device shell am start -n com.dsh.remote/.MainActivity | Out-Null
Start-Sleep -Seconds 9

$before = Get-ImeTop
Write-Output "收起态 imeTop=$before"

$sw = [Diagnostics.Stopwatch]::StartNew()
# 后台发 tap，主线程立刻开始采样
$tapJob = Start-Job -ScriptBlock {
    param($adb,$dev,$x,$y)
    & $adb -s $dev shell input tap $x $y
} -ArgumentList $Adb,$Device,$TapX,$TapY

$samples = @()
while ($sw.ElapsedMilliseconds -lt 6000) {
    $t = $sw.ElapsedMilliseconds
    $top = Get-ImeTop
    $samples += [pscustomobject]@{ t = $t; top = $top }
}
Wait-Job $tapJob | Out-Null; Remove-Job $tapJob

# 只保留数值发生变化的采样点，并算出归一化进度
$prev = $null
$base = $before
$end  = ($samples | Where-Object { $_.top -gt 0 } | Select-Object -Last 1).top
if ($end -eq $base) { Write-Output "警告：键盘未弹出（end=$end）" }
$span = $end - $base

Write-Output ""
Write-Output ("基准 base={0}  终值 end={1}  位移 span={2}" -f $base, $end, $span)
Write-Output "   t(ms)   imeTop   进度%   系统曲线(cubic-bezier .4,0,.2,1)"
foreach ($s in $samples) {
    if ($s.top -eq $prev) { continue }
    $prev = $s.top
    if ($span -eq 0) { continue }
    $p = [math]::Round((($s.top - $base) / $span) * 100, 1)
    Write-Output ("{0,8} {1,8} {2,8}" -f $s.t, $s.top, $p)
}

Set-AnimationScale 1
Write-Output ""
Write-Output "动画缩放已复原为 1"
