use crate::{AppState, Mode};
use github_api::ClientOptions;
use std::{env, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(crate) const STREAM_BUFFER_BATCHES: usize = 8;
pub(crate) const STREAM_FINISH_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const CACHE_MAX_ENTRIES: usize = 32;
pub(crate) const CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const CACHE_MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const _: () = assert!(CACHE_MAX_ENTRIES > 0 && CACHE_MAX_ENTRY_BYTES <= CACHE_MAX_BYTES);

#[derive(Clone)]
pub(crate) struct Config {
    pub port: u16,
    pub cache_ttl: Duration,
    pub max_concurrent_syncs: usize,
    pub sync_timeout: Duration,
    pub github: ClientOptions,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 8080,
            cache_ttl: Duration::from_secs(1800),
            max_concurrent_syncs: 4,
            sync_timeout: Duration::from_secs(120),
            github: ClientOptions::default(),
        }
    }
}

fn parse_number(
    name: &str,
    value: Option<&str>,
    fallback: u64,
    maximum: u64,
) -> Result<u64, String> {
    match value {
        None => Ok(fallback),
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| (1..=maximum).contains(value))
            .ok_or_else(|| format!("{name} must be an integer between 1 and {maximum}")),
    }
}

fn number(name: &str, fallback: u64, maximum: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) => parse_number(name, Some(&value), fallback, maximum),
        Err(env::VarError::NotPresent) => parse_number(name, None, fallback, maximum),
        Err(_) => Err(format!("{name} must contain a valid integer")),
    }
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let defaults = Self::default();
        Ok(Self {
            port: number("PORT", u64::from(defaults.port), 65535)? as u16,
            cache_ttl: Duration::from_secs(number(
                "DASHBOARD_CACHE_TTL_SECONDS",
                defaults.cache_ttl.as_secs(),
                86400,
            )?),
            max_concurrent_syncs: number(
                "DASHBOARD_MAX_CONCURRENT_SYNCS",
                defaults.max_concurrent_syncs as u64,
                64,
            )? as usize,
            sync_timeout: Duration::from_secs(number(
                "DASHBOARD_SYNC_TIMEOUT_SECONDS",
                defaults.sync_timeout.as_secs(),
                3600,
            )?),
            github: ClientOptions {
                request_timeout: Duration::from_secs(number(
                    "GITHUB_REQUEST_TIMEOUT_SECONDS",
                    defaults.github.request_timeout.as_secs(),
                    300,
                )?),
                max_concurrent_repositories: std::num::NonZeroUsize::new(number(
                    "GITHUB_MAX_CONCURRENT_REPOSITORIES",
                    defaults.github.max_concurrent_repositories.get() as u64,
                    32,
                )?
                    as usize)
                .expect("positive configuration"),
            },
        })
    }
}

impl AppState {
    pub(crate) fn from_env() -> Result<Self, String> {
        let config = Config::from_env()?;
        let mode = match env::var("DASHBOARD_AUTH").as_deref().unwrap_or("gh") {
            "gh" => Mode::Gh,
            "proxy" => Mode::Proxy,
            "demo" => Mode::Demo,
            _ => return Err("DASHBOARD_AUTH must be gh, proxy or demo".into()),
        };
        if mode != Mode::Proxy
            && (env::var_os("CC_REQUEST_FLOW").is_some() || env::var_os("APP_ID").is_some())
        {
            return Err("Clever Cloud requires DASHBOARD_AUTH=proxy".into());
        }
        let default_owner = env::var("GITHUB_DEFAULT_OWNER")
            .ok()
            .filter(|v| !v.is_empty());
        if let Some(owner) = &default_owner {
            github_api::validate_owner(owner).map_err(|e| e.to_string())?;
        }
        let allowed_users: Vec<String> = env::var("DASHBOARD_ALLOWED_USERS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        for user in &allowed_users {
            github_api::validate_owner(user).map_err(|e| e.to_string())?;
        }
        if mode == Mode::Proxy && allowed_users.is_empty() {
            return Err(
                "Set DASHBOARD_ALLOWED_USERS to the GitHub logins allowed to use this dashboard"
                    .into(),
            );
        }
        Ok(Self {
            mode,
            default_owner,
            allowed_users,
            requests: Arc::new(Semaphore::new(config.max_concurrent_syncs)),
            cache: Arc::new(std::sync::Mutex::new(crate::sync::Cache::default())),
            config,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_numbers_are_bounded_and_invalid_values_fail_startup() {
        assert_eq!(parse_number("TTL", None, 1800, 86400).unwrap(), 1800);
        assert_eq!(
            parse_number("TTL", Some("3600"), 1800, 86400).unwrap(),
            3600
        );
        for value in [
            "0",
            "-1",
            "1.5",
            "",
            "86401",
            "18446744073709551616",
            "forever",
        ] {
            let error = parse_number("TTL", Some(value), 1800, 86400).unwrap_err();
            assert!(error.contains("TTL"));
        }
    }
}
