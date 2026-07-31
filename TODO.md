# TODO

- [ ] The three client origins have no authentication of their own: anyone who can load
      one of the interfaces can spend that client's ecash, because nginx proxies
      `/bridge/` to a loopback bridge that skips its own auth-token requirement for
      loopback binds. Documented as a limitation for now. A real fix needs the
      application to gate the UI (or the bridge to require a token the UI holds), not a
      packaging workaround.
- [ ] `riscv64` is not built. The Rust bridge and the base images would need to be
      confirmed to build there before adding it to `arch` and `ARCHES`.
