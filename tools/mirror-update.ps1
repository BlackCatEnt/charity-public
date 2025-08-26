# adjust paths once; then just run this file each time
$src  = "C:\twitch-bot\Charity"
$dest = "C:\repos\charity-public"
$repo = "https://github.com/BlackCatEnt/charity-public.git"

pwsh -File "$PSScriptRoot\mirror-publish.ps1" -Source $src -Dest $dest -RepoUrl $repo
