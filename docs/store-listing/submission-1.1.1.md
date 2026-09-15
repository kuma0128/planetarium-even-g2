# 1.1.1 resubmission

- Submitted: September 15, 2026 at 16:41 JST.
- Portal: https://hub.evenrealities.com/hub/io.github.kuma0128.planetarium/store-listing
- Observed status: **In review**, **Awaiting review...**.
- Package: `g2-planetarium.ehpk`, 198,499 bytes.
- SHA-256: `dc058ba9742ba6e399778bda929185abf221517e790f5008f5b907ddc203624e`.
- Version: 1.1.1; SDK: 0.0.15; minimum Even app: 2.2.10.
- About: `about.txt` (1,978 characters excluding its final newline).
- Build change log: 477 characters describing the exit-cancel fix and reviewer steps.

## Verification

- Reproduced the reported second-double-tap failure with the old implementation
  on both startup and sky pages before applying the fix.
- `npm test`: 35 passed.
- `npm run test:browser`: 90 passed, 2 documentation screenshot tests skipped.
- `npm run pack`: TypeScript check, production build and packaging passed.
- `git diff --check`: passed.
- One self-review completed: checked overlay event semantics against official
  documentation, startup event handling, repeated cancellation, rejected dialog
  requests, stale in-flight transfers, confirmed exit, and version consistency.
- Browser tests use the real SDK with a mock native host. No physical G2 test
  was performed. Native simulator UI access timed out, so no simulator validation
  is claimed for this fix.

At the time of portal submission, validation was local; no commit, push or CI
run had yet been performed. The source was subsequently prepared for main at
the developer’s request.
