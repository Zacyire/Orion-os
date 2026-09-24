//! Read-only host statistics for `GET /api/system/stats`.
//!
//! A small, fixed, allowlisted snapshot — CPU usage and core count, memory,
//! host uptime, OS/arch — intended for future first-party desktop widgets.
//! It never exposes hostnames, users, paths, environment, processes, disks or
//! network interfaces; the `sysinfo` features that could enumerate users,
//! disks, networks or components are not even compiled in (see Cargo.toml).
//! Nothing here writes to the host or runs commands.
//!
//! CPU usage is a delta between two readings, so the sampler keeps one
//! `System` for the server's lifetime: a baseline is taken at startup and the
//! system is re-read at most once per `MINIMUM_CPU_UPDATE_INTERVAL`. Requests
//! arriving faster than that share the latest snapshot, which also bounds the
//! work a flood of requests can cause. Until a valid delta exists,
//! `usage_percent` is `null` rather than a misleading `0`.

use std::{
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System, IS_SUPPORTED_SYSTEM, MINIMUM_CPU_UPDATE_INTERVAL};

/// Bump when the response shape changes incompatibly.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub schema: u32,
    /// Unix time (ms) at which the host was last sampled.
    pub sampled_at_ms: u64,
    pub platform: Platform,
    /// Host (not server) uptime in seconds; null where unsupported.
    pub uptime_seconds: Option<u64>,
    pub cpu: Cpu,
    pub memory: Memory,
}

#[derive(Debug, Clone, Serialize)]
pub struct Platform {
    /// `std::env::consts::OS`, e.g. "linux", "macos", "windows".
    pub os: &'static str,
    /// `std::env::consts::ARCH`, e.g. "x86_64", "aarch64".
    pub arch: &'static str,
    /// False when this platform can't report stats; all metrics are then null.
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cpu {
    /// Whole-system CPU usage, 0–100, one decimal; null until two samples exist.
    pub usage_percent: Option<f32>,
    pub logical_cores: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Memory {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

pub struct Sampler {
    inner: Mutex<Inner>,
}

struct Inner {
    sys: System,
    /// When the CPU/memory figures were last read (the baseline, initially).
    last_refresh: Instant,
    /// True once a refresh has happened at least MINIMUM_CPU_UPDATE_INTERVAL
    /// after the baseline, i.e. CPU usage is a real delta.
    cpu_valid: bool,
    snapshot: Snapshot,
}

fn refresh_kind() -> RefreshKind {
    RefreshKind::nothing()
        .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
        .with_memory(MemoryRefreshKind::nothing().with_ram())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn build(sys: &System, cpu_valid: bool) -> Snapshot {
    let supported = IS_SUPPORTED_SYSTEM;
    let nonzero = |v: u64| (supported && v > 0).then_some(v);
    let total = nonzero(sys.total_memory());
    // Clamp so used/available can never exceed total, whatever the platform reports.
    let cap = |v: u64| total.map(|t| v.min(t));
    Snapshot {
        schema: SCHEMA_VERSION,
        sampled_at_ms: now_ms(),
        platform: Platform { os: std::env::consts::OS, arch: std::env::consts::ARCH, supported },
        uptime_seconds: supported.then(System::uptime),
        cpu: Cpu {
            usage_percent: (supported && cpu_valid).then(|| {
                let u = sys.global_cpu_usage();
                if u.is_finite() { (u.clamp(0.0, 100.0) * 10.0).round() / 10.0 } else { 0.0 }
            }),
            logical_cores: (supported && !sys.cpus().is_empty()).then(|| sys.cpus().len()),
        },
        memory: Memory {
            total_bytes: total,
            used_bytes: cap(sys.used_memory()),
            available_bytes: cap(sys.available_memory()),
        },
    }
}

impl Sampler {
    /// Takes the CPU baseline immediately (call once, at server start).
    pub fn new() -> Self {
        let sys = System::new_with_specifics(refresh_kind());
        let snapshot = build(&sys, false);
        Sampler { inner: Mutex::new(Inner { sys, last_refresh: Instant::now(), cpu_valid: false, snapshot }) }
    }

    /// Current snapshot. Re-reads the host only if the minimum CPU interval has
    /// elapsed since the last read; otherwise returns the latest snapshot.
    pub fn sample(&self) -> Snapshot {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.last_refresh.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL {
            g.sys.refresh_specifics(refresh_kind());
            g.last_refresh = Instant::now();
            g.cpu_valid = true;
            let snap = build(&g.sys, true);
            g.snapshot = snap;
        }
        g.snapshot.clone()
    }
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settled() -> Snapshot {
        let s = Sampler::new();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50));
        s.sample()
    }

    #[test]
    fn values_are_sane_on_supported_platforms() {
        let snap = settled();
        assert_eq!(snap.schema, SCHEMA_VERSION);
        assert_eq!(snap.platform.os, std::env::consts::OS);
        assert!(snap.sampled_at_ms > 1_600_000_000_000, "sampled_at_ms looks wrong: {}", snap.sampled_at_ms);
        if !snap.platform.supported {
            return; // everything below is null by contract
        }
        let usage = snap.cpu.usage_percent.expect("cpu usage after a full interval");
        assert!((0.0..=100.0).contains(&usage), "usage {usage}");
        assert!(snap.cpu.logical_cores.unwrap() >= 1);
        let total = snap.memory.total_bytes.expect("total memory");
        assert!(total > 0);
        assert!(snap.memory.used_bytes.unwrap() <= total);
        assert!(snap.memory.available_bytes.unwrap() <= total);
        assert!(snap.uptime_seconds.is_some());
    }

    #[test]
    fn cpu_usage_is_null_before_a_valid_delta() {
        // Immediately after construction there is only the baseline.
        let s = Sampler::new();
        let snap = s.sample();
        assert_eq!(snap.cpu.usage_percent, None);
    }

    #[test]
    fn rapid_requests_share_one_reading() {
        let s = Sampler::new();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50));
        let a = s.sample();
        let b = s.sample();
        let c = s.sample();
        assert_eq!(a.sampled_at_ms, b.sampled_at_ms, "second request within the interval must not re-read the host");
        assert_eq!(b.sampled_at_ms, c.sampled_at_ms);
    }

    #[test]
    fn later_requests_re_read_the_host() {
        let s = Sampler::new();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50));
        let a = s.sample();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL + std::time::Duration::from_millis(50));
        let b = s.sample();
        assert!(b.sampled_at_ms > a.sampled_at_ms);
    }
}
