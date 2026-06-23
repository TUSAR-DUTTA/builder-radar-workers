# builder-radar-workers

Public **runner** repo for BuilderRadar's background automation (Playwright answer-engine
scrapers + social workers). It exists so GitHub Actions runs on **unlimited free public-repo
minutes**.

## How it works
- This repo holds **only** the worker/automation code (`src/workers/**`) + workflows.
- The private application core (`src/db`, `src/lib`) is **not** stored here. Each workflow
  checks it out at runtime from the private repo via `secrets.CORE_REPO_PAT`, copies it into
  `src/`, runs the worker, and the ephemeral runner is destroyed. Core code is never committed
  or uploaded as an artifact.
- Workers write results to the same Supabase database via repository secrets.

## Triggers
Each engine workflow runs on its existing `schedule`, plus `workflow_dispatch` and
`repository_dispatch` (type `run-workers`) for on-demand sampling.

⚠️ Do not commit secrets, sessions, or `.env*` to this repo.
