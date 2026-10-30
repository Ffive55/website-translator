param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = "$PSHOME\Modules" }
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$value = [Console]::In.ReadToEnd().Trim()
if ($Mode -eq 'Protect') {
    $secret = ConvertTo-SecureString -String $value -AsPlainText -Force
    [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secret))
} else {
    $secret = ConvertTo-SecureString -String $value
    [Console]::Out.Write((New-Object System.Net.NetworkCredential('', $secret)).Password)
}
