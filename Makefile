ARCHES := x86 arm

include node_modules/@start9labs/start-sdk/s9pk.mk

# Chama's existing `build` script builds the web application. Override the SDK's
# conventional package target so the StartOS runtime bundle uses its own scripts.
javascript/index.js: $(shell find startos -type f) tsconfig.startos.json node_modules
	npm run startos:check
	npm run startos:build
