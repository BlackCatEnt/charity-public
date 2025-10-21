<#  Sync a single issue into a GitHub Project (v2) and set custom fields
    Reads values from the Story issue form sections in the issue body.

    Usage (local):
      pwsh -File relics/sync-project-fields.ps1 `
        -Owner BlackCatEnt -Repo charity-hive -ProjectNumber 2 -IssueNumber 123

    In CI, GITHUB_TOKEN is provided automatically.
#>

param(
  [Parameter(Mandatory=$true)] [string]$Owner,
  [Parameter(Mandatory=$true)] [string]$Repo,
  [Parameter(Mandatory=$true)] [int]$ProjectNumber,
  [Parameter(Mandatory=$true)] [int]$IssueNumber
)

$ErrorActionPreference = 'Stop'
$env:GH_PAGER = ''              # avoid pager hangs
$env:GH_NO_UPDATE_NOTIFIER='1'  # avoid CLI update prompt

function Get-ProjectMeta {
  param([string]$Owner, [int]$Number)

  $proj = gh project view $Number --owner $Owner --format json | ConvertFrom-Json
  if(-not $proj){ throw "Project not found ($Owner/#$Number)." }

  # Field list (include options for single-selects)
  $fields = gh project field-list $Number --owner $Owner --format json | ConvertFrom-Json

  # Build maps by name (case-insensitive)
  $map = @{
    id     = $proj.id
    fields = @{}
  }
  foreach($f in $fields){
    $map.fields[$f.name.ToLower()] = $f
  }
  return $map
}

function Parse-IssueBody {
  param([string]$Body)

  # Issue Forms render headings as bold lines followed by the value on the next line.
  # Handle both “Epic”/“Area”/“Priority” and “Start date”/“Due date” labels.
  $get = {
    param($label)
    $pattern = "(?ms)^\*\*\Q$label\E\*\*\s*\r?\n([^\r\n]+)"
    $m = [regex]::Match($Body, $pattern)
    if($m.Success){ $m.Groups[1].Value.Trim() } else { $null }
  }

  return [ordered]@{
    Epic     = & $get 'Epic'
    Area     = & $get 'Area (component)'
    ifArea   = & $get 'Area'    # alt label fallback
    Priority = & $get 'Priority'
    Start    = (& $get 'Start date (YYYY-MM-DD)') ?? (& $get 'Start date')
    Due      = (& $get 'Due date (YYYY-MM-DD)')   ?? (& $get 'Due date')
    Milestone= & $get 'Milestone (optional)'
  }
}

function Ensure-ProjectItem {
  param([string]$Owner, [string]$Repo, [int]$IssueNumber, [int]$ProjectNumber)

  $issue = gh api "repos/$Owner/$Repo/issues/$IssueNumber" | ConvertFrom-Json
  if(-not $issue){ throw "Issue $Owner/$Repo#$IssueNumber not found." }

  # Add to project (idempotent)
  $added = gh project item-add $ProjectNumber --owner $Owner --url $issue.html_url --format json 2>$null | ConvertFrom-Json
  if(-not $added){ 
    # Already in project → fetch item id via search
    $items = gh project items $ProjectNumber --owner $Owner --format json | ConvertFrom-Json
    $existing = $items | Where-Object { $_.content?.number -eq $IssueNumber }
    if(-not $existing){ throw "Unable to resolve project item for issue #$IssueNumber." }
    return $existing.id
  }
  return $added.id
}

function Set-SingleSelect {
  param([int]$ProjectNumber, [string]$Owner, [string]$ItemId, [object]$Field, [string]$OptionName)

  if(-not $OptionName){ return }
  $opt = $Field.options | Where-Object { $_.name -eq $OptionName }
  if(-not $opt){ throw "Option '$OptionName' not found on field '$($Field.name)'." }

  gh project item-edit $ProjectNumber --owner $Owner `
    --id $ItemId --field-id $Field.id --single-select-option-id $opt.id `
    --format json 1>$null
}

function Set-DateField {
  param([int]$ProjectNumber, [string]$Owner, [string]$ItemId, [object]$Field, [string]$Date)

  if([string]::IsNullOrWhiteSpace($Date)){ return }
  if(-not $Date -match '^\d{4}-\d{2}-\d{2}$'){ throw "Bad date '$Date' (use YYYY-MM-DD)." }

  gh project item-edit $ProjectNumber --owner $Owner `
    --id $ItemId --field-id $Field.id --date $Date `
    --format json 1>$null
}

# --- run ---
Write-Host "==> Syncing $Owner/$Repo#$IssueNumber into project #$ProjectNumber"

$meta = Get-ProjectMeta -Owner $Owner -Number $ProjectNumber
$body = (gh api "repos/$Owner/$Repo/issues/$IssueNumber" --jq '.body')
$vals = Parse-IssueBody -Body $body

# Resolve fields we care about (case-insensitive lookup)
$F = @{
  epic     = $meta.fields['epic']
  area     = $meta.fields['area']
  priority = $meta.fields['priority']
  start    = $meta.fields['start']
  due      = $meta.fields['due']
}

# Add to project, get item id
$itemId = Ensure-ProjectItem -Owner $Owner -Repo $Repo -IssueNumber $IssueNumber -ProjectNumber $ProjectNumber
Write-Host "   = item id $itemId"

# Apply fields (with fallbacks)
Set-SingleSelect -ProjectNumber $ProjectNumber -Owner $Owner -ItemId $itemId -Field $F.epic     -OptionName $vals.Epic
Set-SingleSelect -ProjectNumber $ProjectNumber -Owner $Owner -ItemId $itemId -Field $F.area     -OptionName ($vals.Area ?? $vals.ifArea)
Set-SingleSelect -ProjectNumber $ProjectNumber -Owner $Owner -ItemId $itemId -Field $F.priority -OptionName $vals.Priority
Set-DateField     -ProjectNumber $ProjectNumber -Owner $Owner -ItemId $itemId -Field $F.start    -Date $vals.Start
Set-DateField     -ProjectNumber $ProjectNumber -Owner $Owner -ItemId $itemId -Field $F.due      -Date $vals.Due

# Milestone (set on the issue; the Project’s Milestone column reflects it)
if($vals.Milestone){
  gh issue edit $IssueNumber -R "$Owner/$Repo" --milestone "$($vals.Milestone)" 1>$null
}

Write-Host "Done."
