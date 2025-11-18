.PHONY: sync
sync:
	uv sync

.PHONY: check
check: lint typecheck test trunk-check

.PHONY: lint
lint:
	uv run ruff check
	uv run docformatter --check -r src tests
	uv run pylint src
	uv run bandit -r src
	uv run yamllint --strict .

.PHONY: typecheck
typecheck:
	uv run mypy src tests

.PHONY: test
test:
	uv run pytest

.PHONY: fix
fix:
	uv run ruff format
	uv run ruff check --fix
	uv run docformatter -r src tests

.PHONY: trunk-check
trunk-check:
	trunk check

.PHONY: trunk-fmt
trunk-fmt:
	trunk fmt

.PHONY: repl
repl:
	uv run ipython
