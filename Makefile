# Include from ok-console/Makefile, or invoke: make -f Makefile.wjax wjax-demo
WJAX_CONSOLE_DIR ?= $(CURDIR)
WJAX_DEMO_DIR ?= $(abspath $(CURDIR)/../openkubes-wjax-local-demo)
WJAX_READER_DIR ?= $(abspath $(CURDIR)/../wjax-console-kind)
WJAX_READER_KUBECONFIG ?= $(WJAX_READER_DIR)/wjax-reader.kubeconfig
WJAX_AI_MODEL ?= llama3.2:latest
WJAX_KUBE_CONTEXT ?= kind-wjax-demo

.PHONY: wjax-demo wjax-demo-check wjax-demo-status wjax-demo-stop wjax-demo-auth
wjax-demo:
	@WJAX_CONSOLE_DIR="$(WJAX_CONSOLE_DIR)" WJAX_DEMO_DIR="$(WJAX_DEMO_DIR)" WJAX_READER_DIR="$(WJAX_READER_DIR)" WJAX_READER_KUBECONFIG="$(WJAX_READER_KUBECONFIG)" WJAX_AI_MODEL="$(WJAX_AI_MODEL)" python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" start
wjax-demo-check:
	@WJAX_CONSOLE_DIR="$(WJAX_CONSOLE_DIR)" WJAX_DEMO_DIR="$(WJAX_DEMO_DIR)" WJAX_READER_DIR="$(WJAX_READER_DIR)" WJAX_READER_KUBECONFIG="$(WJAX_READER_KUBECONFIG)" python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" check
wjax-demo-status:
	@python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" status
wjax-demo-stop:
	@python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" stop

wjax-demo-auth:
	@WJAX_CONSOLE_DIR="$(WJAX_CONSOLE_DIR)" WJAX_DEMO_DIR="$(WJAX_DEMO_DIR)" WJAX_KUBE_CONTEXT="$(WJAX_KUBE_CONTEXT)" python3 "$(WJAX_CONSOLE_DIR)/scripts/wjax_launcher.py" auth
