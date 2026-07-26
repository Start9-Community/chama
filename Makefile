ARCHES := x86 arm

# Published npm builds of the SDK (e.g. 1.5.3) do not always include s9pk.mk.
# Prefer the package-local file; else a common Start9 SDK checkout; else fail loud.
# Override anytime:
#   make START_SDK_MK=/path/to/start-sdk/s9pk.mk x86
START_SDK_MK ?= node_modules/@start9labs/start-sdk/s9pk.mk
ifeq ($(wildcard $(START_SDK_MK)),)
  ifneq ($(wildcard $(HOME)/start9-workspace/start-technologies/projects/start-sdk/s9pk.mk),)
    START_SDK_MK := $(HOME)/start9-workspace/start-technologies/projects/start-sdk/s9pk.mk
  endif
endif
ifeq ($(wildcard $(START_SDK_MK)),)
$(error s9pk.mk missing at $(START_SDK_MK). Use an SDK that ships s9pk.mk (≥2.0.6), or: make START_SDK_MK=/path/to/start-sdk/s9pk.mk x86)
endif
include $(START_SDK_MK)

# StartOS packages discover their catalog artwork from a root-level `icon.*`.
# Always derive it from the same high-resolution canonical mark shipped by
# Tauri so package builds cannot drift to a placeholder or approximation.
icon.png: src-tauri/icons/icon.png
	cp $< $@

ingredients: icon.png

# Chama's existing `build` script builds the web application. Override the SDK's
# conventional package target so the StartOS runtime bundle uses its own scripts.
javascript/index.js: $(shell find startos -type f) tsconfig.startos.json node_modules
	npm run startos:check
	npm run startos:build
