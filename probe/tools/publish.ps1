# 把插件本体（不含 probe/）发布到 GitHub。
#
#   .\probe\tools\publish.ps1 -DryRun        # 只重建分支和 zip，不推送
#   .\probe\tools\publish.ps1                # 推送分支 + 标签（默认 remote = origin）
#   .\probe\tools\publish.ps1 -Remote upstream
#
# 做四件事：
#   1. git subtree 拆出 release 分支 —— 插件成为分支根。这是硬要求：
#      `dsh plugin add github:<用户>/<仓库>` 只认仓库根目录的 package.json
#   2. git archive 打出 dist\dsh-voice-chat-<版本>.zip（只含跟踪内容）
#   3. 打 v<版本> 标签（版本号取自 dsh-voice-chat\package.json）
#   4. 推送 release -> 远程 main，并推送标签
#
# 注意：本文件必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1 读 .ps1
# 时按 ANSI(936) 解析，没有 BOM 的中文会变乱码并把引号吃掉、语法直接崩。
param(
  [string]$Remote = 'origin',
  [switch]$DryRun
)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$manifest = Get-Content "$root\dsh-voice-chat\package.json" -Raw | ConvertFrom-Json
$version = $manifest.version
$tag = "v$version"

# git 把进度写到 stderr，所以这里不设 ErrorActionPreference=Stop，改为逐步查退出码
$dirty = & git status --porcelain
if ($dirty) {
  Write-Host "工作区有未提交的改动，先提交再发布：" -ForegroundColor Yellow
  $dirty | ForEach-Object { Write-Host "  $_" }
  exit 1
}

Write-Host "==> 拆分 release 分支（prefix = dsh-voice-chat）"
# 发布分支每次重建；已存在时 subtree split 会直接失败
& git show-ref --verify --quiet refs/heads/release
if ($LASTEXITCODE -eq 0) { & git branch -D release 2>$null | Out-Null }
& git subtree split --prefix=dsh-voice-chat -b release 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "    拆分失败 ($LASTEXITCODE)" -ForegroundColor Red; exit 1 }
Write-Host "    release -> $(& git rev-parse --short release)"

Write-Host "==> 打安装包"
$zip = "$root\dist\dsh-voice-chat-$version.zip"
New-Item -ItemType Directory -Force -Path "$root\dist" | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
& git archive --format=zip --prefix="dsh-voice-chat/" -o $zip release
if ($LASTEXITCODE -ne 0) { Write-Host "    打包失败" -ForegroundColor Red; exit 1 }
Write-Host ("    dist\dsh-voice-chat-{0}.zip  ({1:N0} 字节)" -f $version, (Get-Item $zip).Length)

& git tag -f -a $tag -m "v$version" 2>$null | Out-Null
Write-Host "==> 标签 $tag"

if ($DryRun) { Write-Host "==> DryRun：到此为止，未推送" -ForegroundColor Cyan; exit 0 }

Write-Host "==> 推送到 $Remote"
& git push $Remote "release:main"
if ($LASTEXITCODE -ne 0) {
  Write-Host "    普通推送被拒（发布分支每次重建），改强制推送"
  & git push $Remote "release:main" --force
  if ($LASTEXITCODE -ne 0) { Write-Host "    推送失败" -ForegroundColor Red; exit 1 }
}

& git push $Remote $tag
if ($LASTEXITCODE -ne 0) { Write-Host "    标签推送失败" -ForegroundColor Red; exit 1 }

Write-Host "==> 完成" -ForegroundColor Green
Write-Host "    最后一步：到 GitHub 的 Releases 页把 dist\dsh-voice-chat-$version.zip 作为附件上传"
