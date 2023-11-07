.PHONY: check
check:
	poetry check
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
