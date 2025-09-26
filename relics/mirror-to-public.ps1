param([string]$branch = "main")
git fetch origin
git fetch public
git checkout $branch
git pull --ff-only origin $branch
git log --oneline --left-right --graph $branch...public/$branch
Write-Host "About to mirror private → public. Ctrl+C to cancel."
Start-Sleep -Seconds 3
git push public $branch --force-with-lease
