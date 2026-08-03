<#
  PR #59 correction round - one-shot verification (run on your machine).

  Safe: touches only a LOCAL Supabase (Docker) and local build/test. It does
  NOT push to hosted Supabase, deploy, commit, or send anything.

  Usage (PowerShell, from repo root):
      pwsh ./scripts/verify-pr59.ps1
  Then paste the whole console output (or the .log file it writes) back.

  Requires: pnpm; and for the SQL proofs, the Supabase CLI + Docker Desktop
  running. If Docker/Supabase is unavailable the script still runs the TS
  checks and clearly marks the SQL step as SKIPPED.
#>

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log   = Join-Path $PSScriptRoot "verify-pr59-$stamp.log"
function Log($m) { $m | Tee-Object -FilePath $log -Append }

Log "== PR#59 verification $stamp =="

# 1) TypeScript build
Log "`n--- pnpm build ---"
pnpm.cmd run build 2>&1 | Tee-Object -FilePath $log -Append
$build = $LASTEXITCODE
Log "build exit: $build"

# 2) Lint
Log "`n--- pnpm lint ---"
pnpm.cmd run lint 2>&1 | Tee-Object -FilePath $log -Append
$lint = $LASTEXITCODE
Log "lint exit: $lint"

# 3) Unit tests
Log "`n--- pnpm test ---"
pnpm.cmd run test 2>&1 | Tee-Object -FilePath $log -Append
$test = $LASTEXITCODE
Log "test exit: $test"

# 3b) Invite email URL contract proof (explicit + visible)
Log "`n--- invite email URL contract proof ---"
pnpm.cmd exec vitest run src/lib/team/invite-email-contract.test.ts 2>&1 |
  Tee-Object -FilePath $log -Append
$contract = $LASTEXITCODE
Log "contract exit: $contract"

# 4) SQL migration + acceptance proofs against LOCAL Supabase only.
#    Supabase ships as a LOCAL dev dependency, so detect and invoke it via
#    `pnpm.cmd exec supabase` rather than expecting a global CLI on PATH.
$sql = 'SKIPPED'
pnpm.cmd exec supabase --version 2>&1 | Out-Null
$hasSupabase = ($LASTEXITCODE -eq 0)
if ($hasSupabase) {
  Log "`n--- pnpm exec supabase db reset (LOCAL) ---"
  pnpm.cmd exec supabase db reset 2>&1 | Tee-Object -FilePath $log -Append
  $reset = $LASTEXITCODE
  if ($reset -eq 0) {
    Log "`n--- pnpm exec supabase test db (pgTAP, LOCAL) ---"
    pnpm.cmd exec supabase test db 2>&1 | Tee-Object -FilePath $log -Append
    $sql = "exit $LASTEXITCODE"
  } else {
    $sql = "db reset FAILED (exit $reset) - migration did not apply cleanly"
  }
} else {
  Log "`nsupabase not available via 'pnpm.cmd exec supabase' - SQL proofs SKIPPED. Validate on staging (with a backup) instead."
}

Log "`n==================== SUMMARY ===================="
Log "build    : $build   (0 = pass)"
Log "lint     : $lint    (0 = pass)"
Log "test     : $test    (0 = pass)"
Log "contract : $contract (0 = pass)"
Log "sql      : $sql"
Log "log written to: $log"
Log "Paste this SUMMARY + any failures above back to Claude."
