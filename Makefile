# Parallel by default (overridable): JOBS=2 make
JOBS ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
MAKEFLAGS += -j$(JOBS) --output-sync=target

.PHONY: check lint typecheck test test-python test-worker check-worker-fixtures deploy-worker test-strict-roundtrip test-roundtrip-verbose fix repl \
        lint-ruff lint-ruff-format lint-docfmt lint-bandit lint-yamllint lint-rumdl lint-tombi \
        type-ty type-pyright

# High-level aggregate
check: lint typecheck test

#################
# Lint (parallel)
#################
lint: lint-ruff lint-ruff-format lint-docfmt lint-bandit lint-yamllint lint-rumdl lint-tombi

lint-ruff:
	uv run ruff check

lint-ruff-format:
	uv run ruff format --check

lint-docfmt:
	uv run docformatter --check -r src tests

lint-bandit:
	uv run bandit -r src

lint-yamllint:
	uv run yamllint --strict .

lint-rumdl:
	uv run rumdl check

lint-tombi:
	uv run tombi check
	uv run tombi format --check

#####################
# Typecheck (parallel)
#####################
typecheck: type-pyright type-ty

type-pyright:
	uv run pyright

type-ty:
	uv run ty check

########
# Tests
########
test: test-python test-worker check-worker-fixtures

test-python:
	uv run pytest

test-worker:
	# npm test was the previous runner; Worker tests now use bun as required by this repository task.
	cd cloudflare/regybox-scheduler && bun run test

check-worker-fixtures:
	@set -e; \
	if [ ! -d tests/html_examples ]; then exit 0; fi; \
	for source in tests/html_examples/*.html; do \
		fixture=cloudflare/regybox-scheduler/test/fixtures/$${source##*/}; \
		diff -u "$$source" "$$fixture"; \
	done; \
	test "$$(find tests/html_examples -maxdepth 1 -type f -name '*.html' -exec basename {} \; | sort)" = "$$(find cloudflare/regybox-scheduler/test/fixtures -maxdepth 1 -type f -name '*.html' -exec basename {} \; | sort)"

deploy-worker:
	cd cloudflare/regybox-scheduler && bun run deploy

########
# Fixes (keep sequential to avoid races)
########
fix:
	uv run ruff format
	uv run ruff check --fix
	uv run docformatter -i -r src tests
	uv run rumdl fmt
	uv run rumdl check --fix
	uv run tombi format

########
# Others
########
repl:
	uv run ipython
