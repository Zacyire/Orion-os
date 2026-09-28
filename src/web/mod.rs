//! # Orion OS web layer
//!
//! Everything that touches remote websites goes through this module. It is
//! a small, self-hosted replacement for a third-party proxy API, built on
//! `reqwest` and running inside the Orion OS server.
//!
//! ```text
//!  App window (web-app / Orion)
//!        │  1. preflight            GET /api/web/inspect?url=…   (inspect.rs)
//!        │  2a. direct iframe       https://site/…               (browser → site; nothing proxied)
//!        │  2b. isolated document   GET /proxy/page?url=…        (page.rs, opaque-origin sandbox)
//!        │  3. resources/data       GET /net/<encoded-url>       (fetch.rs, via the service worker)
//!        ▼
//!  Service worker (static/sw.js) — caches /net/ responses, never touches /api, /proxy, /ws
//!        ▼
//!  guard.rs  — URL/protocol/port validation, SSRF (public IPs only, DNS pinned), allowlist
//!  client.rs — pinned HTTP client, manual redirect following with per-hop re-validation
//!  policy.rs — X-Frame-Options / CSP frame-ancestors evaluation (respected, never stripped)
//!  limit.rs  — per-client token-bucket rate limiting
//!  error.rs  — stable error codes shared with the frontend error screens
//!        ▼
//!  Remote website / API
//! ```
//!
//! ## Policy
//! The layer fetches public content on behalf of the user; it does **not**
//! defeat protections. Concretely:
//! * A page whose `X-Frame-Options` / `frame-ancestors` forbids embedding is
//!   reported as `EMBEDDING_NOT_ALLOWED` and is never rendered in a window.
//! * No cookies, `Authorization` or other credentials are forwarded, so
//!   logins, paywalls and access controls stay exactly as the site set them.
//! * Nothing is done to bypass DRM, bot checks or rate limits of the target.

pub mod client;
pub mod error;
pub mod fetch;
pub mod guard;
pub mod inspect;
pub mod limit;
pub mod page;
pub mod policy;
