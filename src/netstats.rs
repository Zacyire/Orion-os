//! Read-only connectivity/latency for `GET /api/network/stats`.
//!
//! What `latency_ms` measures: the round-trip time for the **LTF server** to
//! make one lightweight HTTP GET to a single, **server-configured** destination
//! (`LTF_NETCHECK_URL`, default [`DEFAULT_NETCHECK_URL`]). It is the *server's*
//! network path, not the user's browser "ping". If LTF runs on the user's
//! machine the two are similar; if LTF is hosted remotely they are not. The
//! widget labels it accordingly.
//!
//! Safety: the destination is fixed by server configuration and can NEVER be
//! chosen by a request — there is no URL/host/IP/port parameter, no DNS lookup
//! from user input, no subprocess, no `ping`, no interface enumeration. The
//! probe client is built with `no_proxy` and a short timeout, and only issues a
//! GET to that one URL.
//!
//! Sampling: a real probe runs at most once per [`MIN_REFRESH`]; requests
//! arriving in between share the cached result (single-flight — only one probe
//! is ever in flight), so a client cannot turn the endpoint into a traffic
//! generator.

use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

/// Default connectivity-check destination: a small, stable, documented
/// infrastructure endpoint that returns a tiny plaintext body. Override with
/// `LTF_NETCHECK_URL`, or set that variable empty to disable the check.
pub const DEFAULT_NETCHECK_URL: &str = "https://cloudflare.com/cdn-cgi/trace";

/// Minimum time between real network probes.
pub const MIN_REFRESH: Duration = Duration::from_secs(20);
/// Per-probe timeout — bounds how long a triggering request can wait.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Bump when the response shape changes incompatibly.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub schema: u32,
    /// Unix time (ms) of the last probe (or of construction, before the first).
    pub sampled_at_ms: u64,
    /// Whether the server reached the configured destination on the last probe.
    pub online: bool,
    /// Server→destination round-trip in ms (one decimal), or null when the last
    /// probe failed or the check is disabled.
    pub latency_ms: Option<f32>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Inner {
    snapshot: Snapshot,
    /// When the most recent probe was started (None until the first).
    last_attempt: Option<Instant>,
    /// A probe is currently running (single-flight guard).
    in_progress: bool,
}

pub struct NetSampler {
    client: reqwest::Client,
    /// Fixed destination; None disables the check (always reports offline).
    target: Option<String>,
    inner: Mutex<Inner>,
}

impl NetSampler {
    pub fn new(target: Option<String>) -> Self {
        // Dedicated client: go direct (no env proxy) so the measurement is of
        // this server's own path, and never carries credentials or cookies.
        let client = reqwest::Client::builder()
            .user_agent(concat!("LTF-OS/", env!("CARGO_PKG_VERSION"), " connectivity-check"))
            .timeout(PROBE_TIMEOUT)
            .connect_timeout(PROBE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap_or_default();
        let snapshot = Snapshot { schema: SCHEMA_VERSION, sampled_at_ms: now_ms(), online: false, latency_ms: None };
        NetSampler {
            client,
            target: target.filter(|t| !t.trim().is_empty()),
            inner: Mutex::new(Inner { snapshot, last_attempt: None, in_progress: false }),
        }
    }

    /// Run a probe if one is due and none is already running. The caller that
    /// triggers it awaits the result; everyone else returns immediately.
    pub async fn refresh_if_due(&self) {
        let Some(target) = self.target.clone() else { return };
        {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let due = !g.in_progress && g.last_attempt.map_or(true, |t| t.elapsed() >= MIN_REFRESH);
            if !due {
                return;
            }
            g.in_progress = true;
            g.last_attempt = Some(Instant::now());
        }

        let started = Instant::now();
        // Only connectivity matters, so any HTTP response (even 4xx/5xx) counts
        // as "reached the network"; the body is never read.
        let result = self.client.get(&target).send().await;
        let snapshot = match result {
            Ok(_) => {
                let ms = (started.elapsed().as_secs_f32() * 1000.0 * 10.0).round() / 10.0;
                Snapshot { schema: SCHEMA_VERSION, sampled_at_ms: now_ms(), online: true, latency_ms: Some(ms) }
            }
            Err(_) => Snapshot { schema: SCHEMA_VERSION, sampled_at_ms: now_ms(), online: false, latency_ms: None },
        };

        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.snapshot = snapshot;
        g.in_progress = false;
    }

    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).snapshot.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway local HTTP server that answers 200 to any request; returns
    /// its base URL. Keeps tests offline and deterministic.
    async fn mock_server() -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
                });
            }
        });
        (format!("http://{addr}/"), handle)
    }

    /// A port with nothing listening — connection refused, quickly.
    async fn closed_addr() -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("http://{addr}/")
    }

    #[tokio::test]
    async fn reports_online_with_latency_against_a_reachable_target() {
        let (url, _srv) = mock_server().await;
        let s = NetSampler::new(Some(url));
        s.refresh_if_due().await;
        let snap = s.snapshot();
        assert_eq!(snap.schema, SCHEMA_VERSION);
        assert!(snap.online);
        let ms = snap.latency_ms.expect("latency present when online");
        assert!(ms >= 0.0 && ms < 4000.0, "latency {ms}");
        assert!(snap.sampled_at_ms > 1_600_000_000_000);
    }

    #[tokio::test]
    async fn reports_offline_with_null_latency_when_unreachable() {
        let s = NetSampler::new(Some(closed_addr().await));
        s.refresh_if_due().await;
        let snap = s.snapshot();
        assert!(!snap.online);
        assert_eq!(snap.latency_ms, None);
    }

    #[tokio::test]
    async fn disabled_check_never_probes_and_reports_offline() {
        let s = NetSampler::new(Some("   ".into())); // blank == disabled
        s.refresh_if_due().await;
        let snap = s.snapshot();
        assert!(!snap.online);
        assert_eq!(snap.latency_ms, None);
    }

    #[tokio::test]
    async fn rapid_requests_share_one_probe() {
        let (url, _srv) = mock_server().await;
        let s = NetSampler::new(Some(url));
        s.refresh_if_due().await;
        let first = s.snapshot().sampled_at_ms;
        // Well within MIN_REFRESH: no new probe, same sample.
        for _ in 0..5 {
            s.refresh_if_due().await;
            assert_eq!(s.snapshot().sampled_at_ms, first, "a request within MIN_REFRESH must not re-probe");
        }
    }
}
