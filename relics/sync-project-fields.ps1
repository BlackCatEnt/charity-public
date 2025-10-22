<#  Sync a single issue into a GitHub Project (v2) and set custom fields
    Supports resolving by Project Number OR Title.
    Owner hint:
      - Org:  -Owner BlackCatEnt
      - User: -Owner @BlackCatEnt

    Usage (local):
      pwsh -File relics/sync-project-fields.ps1 `
        -Owner @BlackCatEnt -Repo charity-hive -ProjectNumber 2 -IssueNumber 37

    In CI, GITHUB_TOKEN must have: contents:read, issues:write, projects:write
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)] [string]$Owner,
  [Parameter(Mandatory=$true)] [string]$Repo,
  [Parameter()] [Nullable[int]]$ProjectNumber,
  [Parameter()] [string]$ProjectTitle,
  [Parameter(Mandatory=$true)] [int]$IssueNumber
)

$ErrorActionPreference = 'Stop'
$env:GH_PAGER = ''
$env:GH_NO_UPDATE_NOTIFIER = '1'

function Resolve-Project {
  param([string]$Owner, [Nullable[int]]$Number, [string]$Title)

  $isUser = $Owner.StartsWith('@')
  $login  = $Owner.TrimStart('@')

  # Build the GraphQL query (multiline Here-String)
  $listQuery = if ($isUser) {
@"
query(\$login:String!){
  user(login:\$login){
    projectsV2(first:50){
      nodes{ number title id url }
    }
  }
}
"@
  } else {
@"
query(\$login:String!){
  organization(login:\$login){
    projectsV2(first:50){
      nodes{ number title id url }
    }
  }
}
"@
  }

  # Write query to a temp file so Windows quoting never breaks gh
  $tmp = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tmp -Value $listQuery -NoNewline -Encoding UTF8

  try {
    $listRes = gh api graphql -f "query=@$tmp" -F login="$login" | ConvertFrom-Json
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }

  $nodes = if ($isUser) { $listRes.data.user.projectsV2.nodes } else { $listRes.data.organization.projectsV2.nodes }

  if (-not $nodes) {
    throw "No ProjectV2 found for owner '$Owner'. (Check owner scope and token scopes: run 'gh auth refresh -s project'.)"
  }

  # 1) By number
  if ($Number) {
    $hit = $nodes | Where-Object { $_.number -eq $Number } | Select-Object -First 1
    if ($hit) { return $hit }
  }

  # 2) By exact title
  if ($Title) {
    $hit = $nodes | Where-Object { $_.title -eq $Title } | Select-Object -First 1
    if ($hit) { return $hit }
  }

  $pretty = ($nodes | ForEach-Object { "  - #$($_.number): $($_.title)" }) -join "`n"
  throw "Project not found (owner=$Owner, number=$Number, title='$Title'). Available:`n$pretty"
}


function Get-ProjectMeta {
  param([string]$Owner, [Nullable[int]]$Number, [string]$Title)

  $proj = Resolve-Project -Owner $Owner -Number $Number -Title $Title

  # Use gh project field-list to hydrate field IDs
  $fields = gh project field-list $proj.number --owner $Owner --format json | ConvertFrom-Json

  $map = @{
    id     = $proj.id
    number = $proj.number
    fields = @{}
  }
  foreach($f in $fields){ $map.fields[$f.name.ToLower()] = $f }
  return $map
}

function Parse-IssueBody {
  param([string]$Body)

  $get = {
    param($label)
    $pattern = "(?ms)^\*\*\Q$label\E\*\*\s*\r?\n([^\r\n]+)"
    $m = [regex]::Match($Body, $pattern)
    if($m.Success){ $m.Groups[1].Value.Trim() } else { $null }
  }

  return [ordered]@{
    Epic      = & $get 'Epic'
    Area      = & $get 'Area (component)'
    ifArea    = & $get 'Area'
    Priority  = & $get 'Priority'
    Start     = (& $get 'Start date (YYYY-MM-DD)') ?? (& $get 'Start date')
    Due       = (& $get 'Due date (YYYY-MM-DD)')   ?? (& $get 'Due date')
    Milestone = & $get 'Milestone (optional)'
  }
}

function Ensure-ProjectItem {
  param([string]$Owner, [string]$Repo, [int]$IssueNumber, [int]$ProjectNumber)

  $issue = gh api "repos/$Owner/$Repo/issues/$IssueNumber" | ConvertFrom-Json
  if(-not $issue){ throw "Issue $Owner/$Repo#$IssueNumber not found." }

  $added = $null
  try {
    $added = gh project item-add $ProjectNumber --owner $Owner --url $issue.html_url --format json 2>$null | ConvertFrom-Json
  } catch {}

  if($added -and $added.id){ return $added.id }

  # Already added → resolve id
  $items = gh project items $ProjectNumber --owner $Owner --format json | ConvertFrom-Json
  $existing = $items | Where-Object { $_.content?.number -eq $IssueNumber } | Select-Object -First 1
  if(-not $existing){ throw "Unable to resolve project item for issue #$IssueNumber." }
  return $existing.id
}

function Set-SingleSelect {
  param([int]$ProjectNumber, [string]$Owner, [string]$ItemId, [object]$Field, [string]$OptionName)

  if(-not $Field -or -not $OptionName){ return }
  $opt = $Field.options | Where-Object { $_.name -eq $OptionName } | Select-Object -First 1
  if(-not $opt){ throw "Option '$OptionName' not found on field '$($Field.name)'." }

  gh project item-edit $ProjectNumber --owner $Owner `
    --id $ItemId --field-id $Field.id --single-select-option-id $opt.id `
    --format json 1>$null
}

function Set-DateField {
  param([int]$ProjectNumber, [string]$Owner, [string]$ItemId, [object]$Field, [string]$Date)

  if(-not $Field -or [string]::IsNullOrWhiteSpace($Date)){ return }
  if(-not $Date -match '^\d{4}-\d{2}-\d{2}$'){ throw "Bad date '$Date' (use YYYY-MM-DD)." }

  gh project item-edit $ProjectNumber --owner $Owner `
    --id $ItemId --field-id $Field.id --date $Date `
    --format json 1>$null
}

# ---- run ----
Write-Host "==> Syncing $Owner/$Repo#$IssueNumber into project " -NoNewline
if ($ProjectNumber) { Write-Host "#$ProjectNumber" } elseif ($ProjectTitle) { Write-Host "'$ProjectTitle'" } else { Write-Host "(unspecified)" }

$meta = Get-ProjectMeta -Owner $Owner -Number $ProjectNumber -Title $ProjectTitle
$body = (gh api "repos/$Owner/$Repo/issues/$IssueNumber" --jq '.body')
$vals = Parse-IssueBody -Body $body

$F = @{
  epic     = $meta.fields['epic']
  area     = $meta.fields['area']
  priority = $meta.fields['priority']
  start    = $meta.fields['start']
  due      = $meta.fields['due']
}

$itemId = Ensure-ProjectItem -Owner $Owner -Repo $Repo -IssueNumber $IssueNumber -ProjectNumber $meta.number
Write-Host "   = item id $itemId"

Set-SingleSelect -ProjectNumber $meta.number -Owner $Owner -ItemId $itemId -Field $F.epic     -OptionName $vals.Epic
Set-SingleSelect -ProjectNumber $meta.number -Owner $Owner -ItemId $itemId -Field $F.area     -OptionName ($vals.Area ?? $vals.ifArea)
Set-SingleSelect -ProjectNumber $meta.number -Owner $Owner -ItemId $itemId -Field $F.priority -OptionName $vals.Priority
Set-DateField     -ProjectNumber $meta.number -Owner $Owner -ItemId $itemId -Field $F.start    -Date $vals.Start
Set-DateField     -ProjectNumber $meta.number -Owner $Owner -ItemId $itemId -Field $F.due      -Date $vals.Due

if($vals.Milestone){
  gh issue edit $IssueNumber -R "$Owner/$Repo" --milestone "$($vals.Milestone)" 1>$null
}

Write-Host "Done."
