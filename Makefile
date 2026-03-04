# Parallel by default (overridable): JOBS=2 make
JOBS ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
MAKEFLAGS += -j$(JOBS) --output-sync=target

.PHONY: check lint typecheck test test-strict-roundtrip test-roundtrip-verbose fix repl \
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
test:
	uv run pytest

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
