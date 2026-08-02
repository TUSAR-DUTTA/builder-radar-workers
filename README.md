# builder-radar-workers

Public **runner** repo for BuilderRadar's background automation (Playwright answer-engine
scrapers + social workers). It exists so GitHub Actions runs on **unlimited free public-repo
minutes**.

## How it works
- This repo holds **only** the worker/automation code (`src/workers/**`) + workflows.
- The evidence boundary is the exact immutable
  `@builder-radar/evidence-contract@1.0.1` tarball under `vendor/`, verified by SHA-512 and npm
  lockfile integrity. Contract definitions are never copied from private source folders.
- The private database/ingestion implementation (`src/db`, `src/lib`) is **not** stored here. Each
  workflow checks out an exact 40-character commit configured in `PRIVATE_INGESTION_COMMIT`, verifies
  that its contract dependency matches, stages runtime implementation files into `src/`, runs the
  worker, and destroys the ephemeral checkout. A branch such as `main` is never accepted as the
  compatibility boundary.
- Workers write results to the same Supabase database via repository secrets.

## Triggers
Each engine workflow runs on its existing `schedule`, plus `workflow_dispatch` and
`repository_dispatch` (type `run-workers`) for on-demand sampling.

⚠️ Do not commit secrets, sessions, or `.env*` to this repo.
