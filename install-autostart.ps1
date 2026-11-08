# Startet MyLife automatisch (unsichtbar), sobald du dich an Windows anmeldest.
# Rueckgaengig machen: die Datei "MyLife.vbs" im Autostart-Ordner loeschen (Win+R -> shell:startup).
$startup = [Environment]::GetFolderPath('Startup')
$cmd = Join-Path $PSScriptRoot 'start.cmd'
$vbs = Join-Path $startup 'MyLife.vbs'
"CreateObject(""WScript.Shell"").Run """"""$cmd"""""", 0, False" | Set-Content -Encoding ASCII $vbs
Write-Host "Autostart eingerichtet: $vbs"
