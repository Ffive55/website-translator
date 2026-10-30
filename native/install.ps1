param(
    [ValidateSet('chrome','edge','firefox')][string]$Browser = 'chrome',
    [string]$ExtensionId,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = "$PSHOME\Modules" }
$repoRoot = Split-Path -Parent $PSScriptRoot
$hostName = 'local.website_translator'
$registryBase = switch ($Browser) {
    'chrome' { 'HKCU:\Software\Google\Chrome\NativeMessagingHosts' }
    'edge' { 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts' }
    'firefox' { 'HKCU:\Software\Mozilla\NativeMessagingHosts' }
}
$registryPath = Join-Path $registryBase $hostName
if ($Uninstall) {
    if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
    Write-Output '已移除当前浏览器的注册；源码、本机登录记录及同步文件保留。'
    exit
}
if ($Browser -eq 'firefox') { $ExtensionId = 'website-translator@local.invalid' }
elseif (-not $ExtensionId) { $ExtensionId = Read-Host '请粘贴插件设置页显示的当前扩展 ID' }
if ($Browser -ne 'firefox' -and $ExtensionId -notmatch '^[a-p]{32}$') { throw '请传入扩展详情页显示的 32 位扩展 ID。' }
$bundledNode = Join-Path $repoRoot 'runtime\node.exe'
$nodeExecutable = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -CommandType Application | Select-Object -First 1).Source }
$nodeVersion = & $nodeExecutable -p 'process.versions.node'
if ([version]$nodeVersion -lt [version]'24.15.0') { throw '需要 Node.js 24.15.0 或更新版本。' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\jose'))) { throw '请先在项目目录执行 npm ci。' }
$installRoot = Join-Path $repoRoot '.local-native'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$launcher = Join-Path $installRoot 'host.cmd'
$hostScript = Join-Path $PSScriptRoot 'host.cjs'
# Paths are trusted local installation paths, not messages or model output.
if ($nodeExecutable -match '[%\r\n]' -or $hostScript -match '[%\r\n]') { throw '安装路径包含不支持的字符。' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($launcher, "@echo off`r`nsetlocal DisableDelayedExpansion`r`nchcp 65001 >nul`r`n`"$nodeExecutable`" `"$hostScript`"", $utf8)
$manifest = @{ name=$hostName; description='网站翻译插件本地连接程序'; path=$launcher; type='stdio' }
if ($Browser -eq 'firefox') { $manifest.allowed_extensions = @($ExtensionId) }
else { $manifest.allowed_origins = @("chrome-extension://$ExtensionId/") }
$manifestPath = Join-Path $installRoot "$Browser.json"
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output "已注册 $Browser。请在管理页检查连接；此步骤不代表 ChatGPT 登录或 OneDrive 云端同步成功。"
