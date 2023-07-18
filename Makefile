.PHONY: check
check:
	poetry check
	poetry run black --preview --check regibox/ tests/
	poetry run isort --check-only regibox/ tests/
	poetry run mypy regibox/ tests/
	poetry run pylint regibox/ tests/
	poetry run ruff regibox/ tests/
	poetry run yamllint .
	poetry run pyupgrade **/*.py

.PHONY: fix
fix:
	poetry run black --preview regibox/ tests/
	poetry run isort regibox/ tests/
	poetry run ruff --fix regibox/ tests/
	poetry run pyupgrade **/*.py

.PHONY: test
test:
	poetry run coverage run --source=regibox/ -m pytest tests/
	poetry run coverage report -m
