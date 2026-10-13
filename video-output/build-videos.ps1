param(
  [string]$Source = 'C:\Users\timur\Videos\Captures\2026-10-14 03-29-16.mp4'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Ffmpeg = Join-Path $PSScriptRoot '.deps\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
$Logo = Join-Path $Root 'assets\tradeperpl-avatar.png'
$DemoAss = Join-Path $PSScriptRoot 'demo-v2.ass'
$PitchAss = Join-Path $PSScriptRoot 'pitch-v2.ass'
$DemoOut = Join-Path $PSScriptRoot 'TradePerpl-technical-demo-clean.mp4'
$PitchOut = Join-Path $PSScriptRoot 'TradePerpl-pitch-clean.mp4'

foreach ($path in @($Source, $Ffmpeg, $Logo, $DemoAss, $PitchAss)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required file: $path"
  }
}

$demoDuration = 96.58
$demoFilter = @"
[0:v]split=5[v0][v1][v2][v3][v4];
[v0]trim=start=0:end=15,setpts=(PTS-STARTPTS)/1.08[c0];
[v1]trim=start=23:end=37,setpts=(PTS-STARTPTS)/1.08[c1];
[v2]trim=start=38:end=73,setpts=(PTS-STARTPTS)/1.08[c2];
[v3]trim=start=74:end=97,setpts=(PTS-STARTPTS)/1.08[c3];
[v4]trim=start=98:end=115.3,setpts=(PTS-STARTPTS)/1.08[c4];
[c0][c1][c2][c3][c4]concat=n=5:v=1:a=0,fps=30,crop=1750:984:170:28,scale=1920:1080,eq=contrast=1.03:saturation=1.05[base];
[1:v]scale=130:130[logo];
[base][logo]overlay=x=1690:y=155:eof_action=repeat[brand];
[brand]subtitles=filename='video-output/demo-v2.ass'[outv]
"@

Push-Location $Root
try {
  & $Ffmpeg -y -i $Source -loop 1 -framerate 30 -i $Logo `
    -filter_complex $demoFilter -map '[outv]' -an `
    -c:v libx264 -preset fast -crf 19 -r 30 -pix_fmt yuv420p `
    -movflags +faststart -t $demoDuration $DemoOut
  if ($LASTEXITCODE -ne 0) { throw "Demo render failed with exit code $LASTEXITCODE" }

  $pitchDuration = 82.87
  $pitchFilter = @"
[0:v]split=5[v0][v1][v2][v3][v4];
[v0]trim=start=0:end=7,setpts=(PTS-STARTPTS)/1.15[c0];
[v1]trim=start=23:end=37,setpts=(PTS-STARTPTS)/1.15[c1];
[v2]trim=start=38:end=73,setpts=(PTS-STARTPTS)/1.15[c2];
[v3]trim=start=75:end=97,setpts=(PTS-STARTPTS)/1.15[c3];
[v4]trim=start=98:end=115.3,setpts=(PTS-STARTPTS)/1.15[c4];
[c0][c1][c2][c3][c4]concat=n=5:v=1:a=0,fps=30,crop=1750:984:170:28,scale=1920:1080,eq=contrast=1.03:saturation=1.05[base];
[1:v]scale=130:130[logo];
[base][logo]overlay=x=1690:y=155:eof_action=repeat[brand];
[brand]subtitles=filename='video-output/pitch-v2.ass'[outv]
"@

  & $Ffmpeg -y -i $Source -loop 1 -framerate 30 -i $Logo `
    -filter_complex $pitchFilter -map '[outv]' -an `
    -c:v libx264 -preset fast -crf 19 -r 30 -pix_fmt yuv420p `
    -movflags +faststart -t $pitchDuration $PitchOut
  if ($LASTEXITCODE -ne 0) { throw "Pitch render failed with exit code $LASTEXITCODE" }
}
finally {
  Pop-Location
}

Get-Item -LiteralPath $DemoOut, $PitchOut | Select-Object FullName, Length, LastWriteTime
