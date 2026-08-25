# Run all five HubSpot syncs locally, in the same order as the GitHub Action.
#
# Use this when GitHub Actions minutes are exhausted, or to force a catch-up without
# waiting for the hourly schedule. It does exactly what the workflow does and consumes
# no Actions minutes.
#
# Set your HubSpot private app token in this terminal session first:
#
#   $env:HUBSPOT_ACCESS_TOKEN = 'pat-eu1-your-token-here'
#
# Then run:
#
#   .\run-all.ps1
#
# The token is read from the environment and is never written to disk by this script.
# Do not paste it into a file in this repo and do not commit it.

if (-not $env:HUBSPOT_ACCESS_TOKEN) {
    Write-Host "HUBSPOT_ACCESS_TOKEN is not set in this session." -ForegroundColor Red
    Write-Host ""
    Write-Host "Set it first, then re-run:"
    Write-Host "  `$env:HUBSPOT_ACCESS_TOKEN = 'pat-eu1-your-token-here'"
    exit 1
}

if (-not (Test-Path "scripts")) {
    Write-Host "No 'scripts' folder here. Run this from the root of the hubspot-automations repo." -ForegroundColor Red
    exit 1
}

# Same order as the workflow: expansion adds to subscriptions before cancellations
# reduce or end them, and discounts apply last.
$syncs = @(
    "expansion-sync",
    "full-cancellation-sync",
    "cancellation-sync",
    "failed-pay-sync",
    "discount-sync"
)

$failed = @()

foreach ($s in $syncs) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host " $s" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan

    node "scripts/$s.mjs"

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  $s FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
        $failed += $s
    }
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
if ($failed.Count -gt 0) {
    Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "All five syncs completed successfully." -ForegroundColor Green
