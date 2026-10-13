# 发布插件（不含 probe/）到 GitHub。
#
#   .\probe\tools\publish.ps1 -DryRun          # 预演：重建分支和 zip，不推送
#   .\probe\tools\publish.ps1                  # 正式发布（推分支 + 标签）
#   .\probe\tools\publish.ps1 -ReplaceTag      # 同一版本号重发（覆盖远程标签）
#   .\probe\tools\publish.ps1 -Remote upstream
#
# 发布前必须先做两件事，脚本会强制检查：
#   1. 工作区干净（有未提交改动直接拒绝）
#   2. dsh-voice-chat\CHANGELOG.md 里已经有 ## [<package.json 的 version>] 一节
#
# 然后它做四件事：
#   1. git subtree split 拆出 release 分支 —— 插件成为分支根。这是硬要求：
#      `dsh plugin add github:<用户>/<仓库>` 只认仓库根目录的 package.json
#   2. git archive 打出 dist\dsh-voice-chat-<版本>.zip（只含跟踪内容）
#   3. 打 v<版本> 标签
#   4. 推送 release -> 远程 main，并推送标签
#
# git subtree split 是增量的：新拆出的提交以旧的为父，所以推 main 是**快进**，
# 正常情况不需要强推，线上历史保持线性。
#
# 注意：本文件必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1 读 .ps1
# 时按 ANSI(936) 解析，没有 BOM 的中文会变乱码并把引号吃掉、语法直接崩。
param(
  [string]$Remote = 'origin',
  [switch]$DryRun,
  [switch]$ReplaceTag
)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# 显式按 UTF-8 读，避免 PS 5.1 用 ANSI 解码把中文读成乱码
$utf8 = [System.Text.UTF8Encoding]::new($false)
$manifest = [System.IO.File]::ReadAllText("$root\dsh-voice-chat\package.json", $utf8) | ConvertFrom-Json
$version = $manifest.version
$tag = "v$version"

Write-Host "==> 目标版本 $version（标签 $tag）"

# ── 门槛 1：工作区干净
$dirty = & git status --porcelain
if ($dirty) {
  Write-Host "工作区有未提交的改动，先提交再发布：" -ForegroundColor Yellow
  $dirty | ForEach-Object { Write-Host "  $_" }
  exit 1
}

# ── 门槛 2：CHANGELOG 已记录该版本
$changelog = [System.IO.File]::ReadAllText("$root\dsh-voice-chat\CHANGELOG.md", $utf8)
if ($changelog -notmatch [regex]::Escape("## [$version]")) {
  Write-Host "dsh-voice-chat\CHANGELOG.md 里还没有 ## [$version] 一节。" -ForegroundColor Yellow
  Write-Host "先写清楚这个版本改了什么，再发布 —— 否则版本历史就是空的。"
  exit 1
}

# ── 1. 拆出发布分支（每次重建；已存在时 subtree split 会失败）
Write-Host "==> 拆分 release 分支（prefix = dsh-voice-chat）"
& git show-ref --verify --quiet refs/heads/release
if ($LASTEXITCODE -eq 0) { & git branch -D release 2>$null | Out-Null }
& git subtree split --prefix=dsh-voice-chat -b release 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "    拆分失败 ($LASTEXITCODE)" -ForegroundColor Red; exit 1 }
Write-Host "    release -> $(& git rev-parse --short release)"

# ── 2. 打安装包
Write-Host "==> 打安装包"
$zip = "$root\dist\dsh-voice-chat-$version.zip"
New-Item -ItemType Directory -Force -Path "$root\dist" | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
& git archive --format=zip --prefix="dsh-voice-chat/" -o $zip release
if ($LASTEXITCODE -ne 0) { Write-Host "    打包失败" -ForegroundColor Red; exit 1 }
Write-Host ("    dist\dsh-voice-chat-{0}.zip  ({1:N0} 字节)" -f $version, (Get-Item $zip).Length)

# ── 3. 标签
& git tag -f -a $tag -m "v$version" 2>$null | Out-Null
Write-Host "==> 标签 $tag"

# 从远程 URL 推出仓库主页，最后给出 Release 链接
$remoteUrl = & git remote get-url $Remote 2>$null
$slug = $null
if ("$remoteUrl" -match 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)') {
  $slug = "$($Matches.owner)/$($Matches.repo)"
}

if ($DryRun) {
  Write-Host "==> DryRun：到此为止，未推送" -ForegroundColor Cyan
  Write-Host "    安装包在 dist\dsh-voice-chat-$version.zip"
  exit 0
}

# ── 4a. 远程是否已有同名标签
$remoteTagLine = & git ls-remote --tags $Remote "refs/tags/$tag" 2>$null
if ($remoteTagLine) {
  $remoteSha = ($remoteTagLine -split '\s+')[0]
  $localSha = ("$(& git rev-parse "$tag^{commit}")").Trim()
  if ($remoteSha -ne $localSha) {
    if (-not $ReplaceTag) {
      Write-Host "远程已存在标签 $tag 且指向别的提交。" -ForegroundColor Yellow
      Write-Host "如果是同一版本号重发，加 -ReplaceTag；否则先把 package.json 的 version 改掉。"
      exit 1
    }
    Write-Host "==> 覆盖远程标签 $tag（-ReplaceTag）"
    & git push $Remote ":refs/tags/$tag" 2>$null | Out-Null
  }
}

# ── 4b. 推送
Write-Host "==> 推送到 $Remote"
& git push $Remote "release:main"
if ($LASTEXITCODE -ne 0) {
  Write-Host "    推送被拒（历史分叉），改强制推送"
  & git push $Remote "release:main" --force
  if ($LASTEXITCODE -ne 0) { Write-Host "    推送失败" -ForegroundColor Red; exit 1 }
}

& git push $Remote $tag
if ($LASTEXITCODE -ne 0) { Write-Host "    标签推送失败" -ForegroundColor Red; exit 1 }

Write-Host "==> 完成" -ForegroundColor Green
Write-Host "    安装包：dist\dsh-voice-chat-$version.zip"
if ($slug) {
  Write-Host "    最后一步（手工）：到下面这个页面把安装包传上去"
  Write-Host "      https://github.com/$slug/releases/new?tag=$tag" -ForegroundColor Cyan
} else {
  Write-Host "    最后一步：到 GitHub 的 Releases 页建 $tag，把安装包作为附件上传"
}
