.DEFAULT_GOAL := help

# Include from ok-console/Makefile, or invoke: make -f Makefile.wjax wjax-demo
WJAX_CONSOLE_DIR ?= $(CURDIR)
WJAX_DEMO_DIR ?= $(abspath $(CURDIR)/demos/wjax-2026)
WJAX_DEMO_RUNTIME_DIR ?= $(abspath $(CURDIR)/.wjax-local-runtime)
WJAX_READER_DIR ?= $(WJAX_DEMO_DIR)/reader
WJAX_READER_KUBECONFIG ?= $(WJAX_DEMO_RUNTIME_DIR)/wjax-reader.kubeconfig
WJAX_AI_MODEL ?= llama3.2:latest
WJAX_KUBE_CONTEXT ?= kind-wjax-demo

.PHONY: wjax-demo wjax-demo-check wjax-demo-status wjax-demo-stop wjax-demo-auth
wjax-demo:
	@WJAX_CONSOLE_DIR="$(WJAX_CONSOLE_DIR)" WJAX_DEMO_DIR="$(WJAX_DEMO_DIR)" WJAX_READER_DIR="$(WJAX_READER_DIR)" WJAX_READER_KUBECONFIG="$(WJAX_READER_KUBECONFIG)" WJAX_AI_MODEL="$(WJAX_AI_MODEL)" WJAX_DEMO_RUNTIME_DIR="$(WJAX_DEMO_RUNTIME_DIR)" python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" start
wjax-demo-check:
	@WJAX_CONSOLE_DIR="$(WJAX_CONSOLE_DIR)" WJAX_DEMO_DIR="$(WJAX_DEMO_DIR)" WJAX_READER_DIR="$(WJAX_READER_DIR)" WJAX_READER_KUBECONFIG="$(WJAX_READER_KUBECONFIG)" WJAX_DEMO_RUNTIME_DIR="$(WJAX_DEMO_RUNTIME_DIR)" python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" check
wjax-demo-status:
	@python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" status
wjax-demo-stop:
	@python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" stop

wjax-demo-auth:
	@WJAX_CONSOLE_DIR="$(WJAX_CONSOLE_DIR)" WJAX_DEMO_DIR="$(WJAX_DEMO_DIR)" WJAX_KUBE_CONTEXT="$(WJAX_KUBE_CONTEXT)" WJAX_DEMO_RUNTIME_DIR="$(WJAX_DEMO_RUNTIME_DIR)" python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" auth

.PHONY: wjax-demo-diagnose
wjax-demo-diagnose:
	@python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" diagnose


.PHONY: wjax-demo-verify
wjax-demo-verify:
	python3 scripts/wjax_verify_recovery.py \
	  --demo-dir "$(WJAX_DEMO_RUNTIME_DIR)" \
	  --timeout 90

.PHONY: help
help:
	@printf '%s\n' \
	  'OpenKubes W-JAX 2026 - local demo commands' \
	  '' \
	  '  make                          Show this help (safe default)' \
	  '  make help                     Show this help' \
	  '  make wjax-demo-check          Preflight: inputs, executor auth and RBAC' \
	  '  make wjax-demo                Start local demo services' \
	  '  make wjax-demo-status         Show service status' \
	  '  make wjax-demo-stop           Stop local demo services' \
	  '  make wjax-demo-reset-session  Stop services and archive session evidence' \
	  '  make wjax-demo-verify         Independently verify Kubernetes recovery' \
	  '  make wjax-demo-auth           Rotate Reader + Executor tokens (72h default)' \
	  '  make wjax-demo-diagnose       Diagnose local demo services' \
	  '' \
	  'URLs: Console http://127.0.0.1:8790/#/wjax | Agentic http://127.0.0.1:8788/'
.PHONY: wjax-demo-reset-session
wjax-demo-reset-session: wjax-demo-stop
	@python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_reset_session.py" \
	  --runtime-dir "$(WJAX_DEMO_RUNTIME_DIR)"
