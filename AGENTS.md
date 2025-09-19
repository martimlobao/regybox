# Agent Instructions

- This repository uses [uv](https://docs.astral.sh/uv/) for dependency management. Use `uv sync` when dependencies change and `uv run <command>` for tooling.
- The Python package follows the `src/` layout. Reference application modules from `src/regybox`.
- Before sending changes, run `make lint`, `make typecheck`, and `make test`, which are shortcuts for quality checks (e.g., `uv run pytest`, `uv run ruff check`, `uv run mypy src tests`).
