.PHONY: update
update:
	poetry update
	pants update-build-files ::
	pants generate-lockfiles ::
	$(pants 2>/dev/null)
	$(pants list :: 2>/dev/null)
	$(pants filedeps :: 2>/dev/null)

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
