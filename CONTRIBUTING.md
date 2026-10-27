# Contributing

Issues and pull requests are welcome.

1. Fork the repository and make your change on a branch of your fork.
2. Read [CLAUDE.md](CLAUDE.md) — it lists the binding conventions (English
   only, storage via `StorageService`, tests first, regenerating `openapi.json`).
3. Run the tests before opening a PR:
   ```bash
   docker compose exec postgres psql -U endoscopy -c "CREATE DATABASE endoscopy_test;"  # once
   cd backend && uv run pytest
   cd frontend && npm test
   ```
   Some backend tests are known to fail on `master` (see ROADMAP.md); do not
   treat those as regressions from your change.
4. Keep PRs small and describe what you verified in the browser, if the change
   touches the UI.

By contributing you agree that your contribution is licensed under Apache 2.0.

Never commit patient data, real endoscopic footage, or credentials.
