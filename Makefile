.PHONY: update
update:
	poetry update
	pants update-build-files ::
	pants generate-lockfiles ::
	pants
	pants list :: > /dev/null
	pants filedeps :: > /dev/null

.PHONY: check
check:
	poetry check
	pants tailor --check update-build-files --check ::
	pants lint check ::

.PHONY: fix
fix:
	pants fix ::

.PHONY: test
test:
	pants test ::

.PHONY: repl
repl:
	pants repl //:root
