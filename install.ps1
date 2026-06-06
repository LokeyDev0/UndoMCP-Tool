$ErrorActionPreference = 'Stop'

$binaryName = "undomcp-win-x64.exe"
$downloadUrl = "https://github.com/LokeyDev0/UndoMCP-Tool/releases/latest/download/$binaryName"

$installDir = Join-Path $HOME ".undomcp\bin"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

$exePath = Join-Path $installDir "undomcp.exe"

Write-Host "Downloading undomcp from $downloadUrl..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $exePath -UseBasicParsing

# Update user PATH environment variable if not already present
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*\.undomcp\bin*") {
    $newUserPath = "$userPath;$installDir"
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "Added $installDir to User PATH."
}

Write-Host "Running setup command..."
$env:Path = "$env:Path;$installDir"
& $exePath setup

Write-Host "undomcp was successfully installed!"
Write-Host "Please restart your terminal/IDE for the PATH changes to take effect."
