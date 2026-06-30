# Changelog

All notable changes to `@nirholas/x402-server` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-30

### Added
- Initial standalone release of the x402 seller core: build 402 challenges and
  run the verify → dispatch → settle flow. Zero runtime dependencies.
- USDC settlement out of the box; optional `$THREE` (Solana SPL) settlement token
  via `acceptThree` / `asset: 'three'`.
- `X402Error` / `PaymentRequiredError` with stable `code` / `status` shape.
- Comprehensive documentation: README (quickstart, verify→settle sequence diagram,
  full API reference, configuration reference, networks & assets, error-code
  table, security notes, FAQ), `docs/api.md`, `docs/examples.md` (Express, Vercel,
  raw Node, fetch-style runtimes, USDC-only and USDC+optional-`$THREE`), and
  `CONTRIBUTING.md`.

### Changed
- Published as `@nirholas/x402-server`. Host-neutral: no facilitator host is baked
  in — the facilitator URL is supplied per call or via `X402_FACILITATOR_URL`.
- The shared error type is `X402Error` (USDC remains the default asset).

[0.1.0]: https://github.com/nirholas/x402-server/releases/tag/v0.1.0
