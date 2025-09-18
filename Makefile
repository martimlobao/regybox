.PHONY: sync
sync:
	uv sync

.PHONY: check
check: lint typecheck test trunk-check

.PHONY: lint
lint:
	uv run docformatter --check -r src tests
	uv run ruff check src tests
	uv run pylint src/regybox
	uv run bandit -r src/regybox
	uv run yamllint .
	trunk check

.PHONY: format
format:
	uv run docformatter -r src tests
	uv run ruff check --select I --fix src tests

.PHONY: typecheck
typecheck:
	uv run mypy src tests

.PHONY: test
test:
	uv run pytest

.PHONY: trunk-check
trunk-check:
	trunk check

.PHONY: trunk-fmt
trunk-fmt:
	trunk fmt
