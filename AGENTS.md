# Agent Instructions

- This repository uses [uv](https://docs.astral.sh/uv/) for dependency management. Use `uv sync` when dependencies change and `uv run <command>` for tooling.
- The Python package follows the `src/` layout. Reference application modules from `src/regybox`.
- Before sending changes, run `uv run pytest` and any other relevant `uv run` quality checks (e.g., `uv run ruff check src tests`, `uv run mypy src tests`).
