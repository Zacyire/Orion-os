//! Per-client token-bucket rate limiting for the web layer.
//!
//! Each client IP gets `burst` tokens that refill at `per_minute / 60` per
//! second; every proxied request costs one. Idle buckets are pruned so the
//! map can't grow without bound. Client IP comes from the socket, or from
//! `X-Forwarded-For` only when `LTF_TRUST_PROXY_HEADERS=1` (i.e. when Orion OS
//! runs behind a reverse proxy you control).

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Mutex,
    time::Instant,
};

use axum::{
    extract::{ConnectInfo, Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::error::{Code, WebError};
use crate::state::SharedState;

pub struct RateLimiter {
    per_sec: f64,
    burst: f64,
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

impl RateLimiter {
    pub fn new(per_minute: u32) -> Self {
        let per_minute = per_minute.max(1) as f64;
        Self { per_sec: per_minute / 60.0, burst: (per_minute / 2.0).max(10.0), buckets: Mutex::new(HashMap::new()) }
    }

    /// Take one token for `ip`; `false` when the client is over its budget.
    pub fn check(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut map = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > 10_000 {
            map.retain(|_, (_, t)| now.duration_since(*t).as_secs() < 600);
        }
        let (tokens, last) = map.entry(ip).or_insert((self.burst, now));
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.per_sec).min(self.burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Axum middleware applied to /proxy, /net and /api/web routes.
pub async fn middleware(State(state): State<SharedState>, req: Request, next: Next) -> Response {
    let ip = client_ip(&req, state.config.trust_proxy_headers);
    if !state.limiter.check(ip) {
        tracing::warn!(target: "ltf_os::web", %ip, path = %req.uri().path(), "rate limited");
        return WebError::new(Code::RateLimited, "Too many requests from this client; try again shortly.").into_response();
    }
    next.run(req).await
}

fn client_ip(req: &Request, trust_headers: bool) -> IpAddr {
    if trust_headers {
        if let Some(ip) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok())
        {
            return ip;
        }
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_limits_bursts() {
        let rl = RateLimiter::new(60); // burst 30
        let ip: IpAddr = "203.0.113.9".parse().unwrap();
        let allowed = (0..40).filter(|_| rl.check(ip)).count();
        assert_eq!(allowed, 30);
        assert!(rl.check("203.0.113.10".parse().unwrap()), "other clients are unaffected");
    }
}
