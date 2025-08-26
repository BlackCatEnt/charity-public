param(
[string]$Source = "C:\twitch-bot\Charity",
[string]$Dest = "C:\repos\charity-public"
)


$include = @(
'docs','modular_phase2','tools','config','package.json','package-lock.json','README.md'
)
$exclude = @(
'.env','data','node_modules','logs','*.sqlite','*.db','*.log','*.pem','*.pfx','*.crt','*.key'
)


# fresh copy
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
New-Item -ItemType Directory -Path $Dest | Out-Null


# copy includes
foreach($i in $include){
$src = Join-Path $Source $i
if(Test-Path $src){
robocopy $src (Join-Path $Dest $i) /E /NFL /NDL /NJH /NJS |
Out-Null
}
}


# remove excluded globs
foreach($pattern in $exclude){
Get-ChildItem -Path $Dest -Recurse -Force -File -Include $pattern | Remove-Item -Force
}


# ensure example config exists
Copy-Item (Join-Path $Source 'config/charity-config.example.json') (Join-Path $Dest 'config/charity-config.json') -Force


# generate PROJECT_MAP.json
$files = git -C $Dest ls-files | ForEach-Object {
$p = $_; $h = (Get-FileHash (Join-Path $Dest $p) -Algorithm SHA1).Hash
[PSCustomObject]@{ path = $p; sha1 = $h }
}
$files | ConvertTo-Json -Depth 3 | Out-File -Encoding UTF8 (Join-Path $Dest 'PROJECT_MAP.json')


Write-Host "Publish staging ready at $Dest"