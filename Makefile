.PHONY: sync
sync:
	uv sync

.PHONY: check
check: lint typecheck test

.PHONY: lint
lint:
        uv run docformatter --check -r src tests
        uv run ruff check src tests
        uv run pylint src/regybox
        uv run bandit -r src/regybox
        uv run yamllint .

.PHONY: format
format:
	uv run docformatter -r src tests
	uv run ruff check --select I --fix src tests
	uv run black src tests

.PHONY: typecheck
typecheck:
	uv run mypy src tests

.PHONY: test
test:
	uv run pytest
