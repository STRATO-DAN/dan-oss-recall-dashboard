# [DAN] RECALL DASHBOARD — developer & CI entrypoints.
# Node standard library + curl only; no build step, no extra dependencies.
.DEFAULT_GOAL := help
.PHONY: help test attack demo bench

NODE ?= node

help: ## Show the available targets
	@echo "[DAN] RECALL DASHBOARD — make targets:"
	@echo ""
	@echo "  make test     Run the full test suite (node --test test/*.test.mjs)"
	@echo "  make attack   Run ONLY the adversarial/security tests (must be green)"
	@echo "  make demo     Boot a throwaway instance and show ranked recall end-to-end"
	@echo "  make bench    BM25 recall latency vs corpus size (100 / 1k / 10k)"
	@echo "  make help     Show this help"
	@echo ""
	@echo "No 'npm install' needed: tests use Node's built-in runner; demo uses curl."

test: ## Run the full test suite
	$(NODE) --test test/*.test.mjs

attack: ## Run only the adversarial/security tests
	@echo "== [DAN] RECALL DASHBOARD — attack suite =="
	@echo "Adversarial tests: per-principal read isolation, secret-egress gate,"
	@echo "rate-limit (429) + per-principal isolation, cross-process lost-update safety + quota."
	@echo ""
	$(NODE) --test test/principals.test.mjs test/secret-egress-gate.test.mjs test/ratelimit.test.mjs test/memory.test.mjs

demo: ## Boot a throwaway instance and show ranked recall
	@bash scripts/demo.sh

bench: ## BM25 recall latency vs corpus size
	@$(NODE) scripts/bench.mjs
