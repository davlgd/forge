use crate::config::{
    CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_MAX_ENTRY_BYTES, STREAM_BUFFER_BATCHES,
    STREAM_FINISH_TIMEOUT,
};
use crate::{ApiError, AppState, Mode, authenticated_context, timestamp};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use github_api::{Client, Error, OwnedRepositories, Repository, Viewer, WorkItem, WorkKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    convert::Infallible,
    future::Future,
    sync::{Arc, LazyLock, Mutex, Weak},
    time::Duration,
};
use tokio::{sync::mpsc, time::Instant};
use tokio_stream::wrappers::ReceiverStream;

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub(super) enum Section {
    #[default]
    Repositories,
    Issues,
    Prs,
}

impl Section {
    fn work_kind(self) -> Option<WorkKind> {
        match self {
            Self::Repositories => None,
            Self::Issues => Some(WorkKind::Issues),
            Self::Prs => Some(WorkKind::Prs),
        }
    }
}

impl From<WorkKind> for Section {
    fn from(kind: WorkKind) -> Self {
        match kind {
            WorkKind::Issues => Self::Issues,
            WorkKind::Prs => Self::Prs,
        }
    }
}

#[derive(Deserialize)]
pub(super) struct SyncQuery {
    owner: Option<String>,
    #[serde(default)]
    priority: Section,
    #[serde(default)]
    refresh: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    login: String,
    avatar_url: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Event {
    Context {
        viewer: Viewer,
        owner: Owner,
        mode: &'static str,
        #[serde(rename = "cacheTtlSeconds")]
        cache_ttl_seconds: u64,
        #[serde(rename = "cacheAgeSeconds")]
        cache_age_seconds: u64,
        cached: bool,
    },
    Repositories {
        repositories: Vec<Repository>,
        total: usize,
        owner: Owner,
    },
    WorkItems {
        kind: WorkKind,
        items: Vec<WorkItem>,
    },
    SectionComplete {
        section: Section,
    },
    Complete {
        #[serde(rename = "fetchedAt")]
        fetched_at: u64,
    },
    Error {
        message: String,
        status: u16,
    },
}

// Fingerprints isolate sessions with different permissions without keeping raw tokens
// in the cache. Keys deliberately do not implement Debug or Serialize.
#[derive(Clone, PartialEq, Eq)]
struct CacheKey {
    credential: [u8; 32],
    viewer: String,
    owner: String,
    mode: &'static str,
}

struct Snapshot {
    owner: Owner,
    lines: Vec<Vec<u8>>,
    fetched_at: u64,
    completed: Instant,
    started: Instant,
    bytes: usize,
}

#[derive(Default)]
pub(crate) struct Cache {
    entries: VecDeque<(CacheKey, Arc<Snapshot>)>,
    generations: Vec<(CacheKey, Weak<()>)>,
}

impl Cache {
    fn prune(&mut self, now: Instant, ttl: Duration) {
        self.entries
            .retain(|(_, snapshot)| now.duration_since(snapshot.completed) < ttl);
        // Only active requests retain generation tickets; the semaphore bounds this list.
        self.generations
            .retain(|(_, generation)| generation.strong_count() > 0);
    }

    fn lookup(
        &mut self,
        key: &CacheKey,
        refresh: bool,
        now: Instant,
        ttl: Duration,
    ) -> (Option<Arc<Snapshot>>, Arc<()>) {
        self.prune(now, ttl);
        if refresh {
            self.entries.retain(|(stored, _)| stored != key);
            // Invalidate only this credential and workspace, including older in-flight writes.
            self.generations.retain(|(stored, _)| stored != key);
        }
        let value = self
            .entries
            .iter()
            .find(|(stored, _)| stored == key)
            .map(|(_, value)| value.clone());
        let generation = self
            .generations
            .iter()
            .find(|(stored, _)| stored == key)
            .and_then(|(_, generation)| generation.upgrade())
            .unwrap_or_else(|| {
                let generation = Arc::new(());
                self.generations
                    .push((key.clone(), Arc::downgrade(&generation)));
                generation
            });
        (value, generation)
    }

    fn insert(&mut self, key: CacheKey, snapshot: Snapshot, generation: &Arc<()>, ttl: Duration) {
        self.prune(Instant::now(), ttl);
        if !self
            .generations
            .iter()
            .any(|(stored, current)| stored == &key && current.ptr_eq(&Arc::downgrade(generation)))
            || snapshot.bytes > CACHE_MAX_ENTRY_BYTES
            || self
                .entries
                .iter()
                .any(|(stored, previous)| stored == &key && previous.started > snapshot.started)
        {
            return;
        }
        self.entries.retain(|(stored, _)| stored != &key);
        while self.entries.len() >= CACHE_MAX_ENTRIES
            || self
                .entries
                .iter()
                .map(|(_, entry)| entry.bytes)
                .sum::<usize>()
                + snapshot.bytes
                > CACHE_MAX_BYTES
        {
            self.entries.pop_front();
        }
        self.entries.push_back((key, Arc::new(snapshot)));
    }
}

#[derive(Default)]
struct Recording {
    owner: Option<Owner>,
    lines: Vec<Vec<u8>>,
    bytes: usize,
    too_large: bool,
}

#[derive(Clone)]
struct Sender {
    channel: mpsc::Sender<Result<Vec<u8>, Infallible>>,
    recording: Arc<Mutex<Recording>>,
    cache_ttl_seconds: u64,
}

impl Sender {
    async fn closed(&self) {
        self.channel.closed().await;
    }

    fn new(channel: mpsc::Sender<Result<Vec<u8>, Infallible>>, cache_ttl_seconds: u64) -> Self {
        Self {
            channel,
            recording: Arc::default(),
            cache_ttl_seconds,
        }
    }
}

async fn send(sender: &Sender, event: Event) -> Result<(), Error> {
    let mut line = serde_json::to_vec(&event).map_err(|_| Error::Upstream)?;
    line.push(b'\n');
    {
        let mut recording = sender.recording.lock().expect("stream recording lock");
        if let Event::Context { owner, .. } | Event::Repositories { owner, .. } = &event {
            recording.owner = Some(owner.clone());
        }
        if !matches!(
            event,
            Event::Context { .. } | Event::Complete { .. } | Event::Error { .. }
        ) && !recording.too_large
        {
            recording.bytes += line.len() + std::mem::size_of::<Vec<u8>>();
            if recording.bytes > CACHE_MAX_ENTRY_BYTES {
                recording.too_large = true;
                recording.lines.clear();
            } else {
                recording.lines.push(line.clone());
            }
        }
    }
    sender
        .channel
        .send(Ok(line))
        .await
        .map_err(|_| Error::Upstream)
}

pub(super) async fn synchronize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SyncQuery>,
) -> Result<Response, ApiError> {
    if let Some(owner) = &query.owner {
        github_api::validate_owner(owner)?;
    }
    let permit = state.requests.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many synchronizations are in progress. Try again in a moment.".into(),
        )
    })?;
    let deadline = Instant::now() + state.config.sync_timeout;
    // Authentication and the username allowlist run before any private bytes are streamed.
    let source = if state.mode == Mode::Demo {
        let owner = DEMO.owner.clone();
        if query
            .owner
            .as_ref()
            .is_some_and(|login| !login.eq_ignore_ascii_case(&owner.login))
        {
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                "This account is not available in the demo.".into(),
            ));
        }
        Source::Demo {
            viewer: DEMO.viewer.clone(),
            owner,
        }
    } else {
        let (client, viewer, credential) =
            tokio::time::timeout_at(deadline, authenticated_context(&state, &headers))
                .await
                .map_err(|_| sync_timeout())?
                .map_err(|error| error.for_mode(state.mode))?;
        let login = query
            .owner
            .or(state.default_owner.clone())
            .unwrap_or_else(|| viewer.login.clone());
        Source::Live {
            client,
            credential: Sha256::digest(credential.as_bytes()).into(),
            viewer,
            login,
            mode: state.mode.label(),
        }
    };
    let key = match &source {
        Source::Live {
            credential,
            viewer,
            login,
            mode,
            ..
        } => CacheKey {
            credential: *credential,
            viewer: viewer.login.to_ascii_lowercase(),
            owner: login.to_ascii_lowercase(),
            mode,
        },
        Source::Demo { viewer, owner } => CacheKey {
            credential: Sha256::digest([]).into(),
            viewer: viewer.login.to_ascii_lowercase(),
            owner: owner.login.to_ascii_lowercase(),
            mode: "demo",
        },
    };
    let started = Instant::now();
    let (cached, generation) = state.cache.lock().expect("cache lock").lookup(
        &key,
        query.refresh,
        started,
        state.config.cache_ttl,
    );
    let (channel, receiver) = mpsc::channel(STREAM_BUFFER_BATCHES);
    let sender = Sender::new(channel, state.config.cache_ttl.as_secs());
    tokio::spawn(async move {
        let _permit = permit;
        if let Some(snapshot) = cached {
            let viewer = match source {
                Source::Live { viewer, .. } | Source::Demo { viewer, .. } => viewer,
            };
            let replay = async {
                send(
                    &sender,
                    Event::Context {
                        viewer,
                        owner: snapshot.owner.clone(),
                        mode: key.mode,
                        cache_ttl_seconds: sender.cache_ttl_seconds,
                        cache_age_seconds: snapshot.completed.elapsed().as_secs(),
                        cached: true,
                    },
                )
                .await?;
                for line in &snapshot.lines {
                    sender
                        .channel
                        .send(Ok(line.clone()))
                        .await
                        .map_err(|_| Error::Upstream)?;
                }
                send(
                    &sender,
                    Event::Complete {
                        fetched_at: snapshot.fetched_at,
                    },
                )
                .await
            };
            tokio::select! { _ = sender.closed() => {}, _ = tokio::time::timeout_at(deadline, replay) => {} }
            return;
        }
        let operation = async {
            match source {
                Source::Live {
                    client,
                    viewer,
                    login,
                    mode,
                    ..
                } => stream_live(&sender, &client, viewer, &login, mode, query.priority).await,
                Source::Demo { viewer, owner } => {
                    stream_demo(&sender, viewer, owner, query.priority).await
                }
            }
            .map_err(|error| ApiError::from(error).for_mode(state.mode))
        };
        if let Some(fetched_at) = finish_stream(&sender, deadline, operation).await {
            let mut recording = sender.recording.lock().expect("stream recording lock");
            let bytes = recording.bytes
                + key.viewer.len()
                + key.owner.len()
                + std::mem::size_of::<Snapshot>()
                + std::mem::size_of::<CacheKey>()
                + (recording.lines.capacity() - recording.lines.len())
                    * std::mem::size_of::<Vec<u8>>()
                + recording.owner.as_ref().map_or(0, |owner| {
                    owner.login.capacity() + owner.avatar_url.capacity()
                });
            if !recording.too_large
                && let Some(owner) = recording.owner.take()
            {
                let snapshot = Snapshot {
                    owner,
                    lines: std::mem::take(&mut recording.lines),
                    fetched_at,
                    completed: Instant::now(),
                    started,
                    bytes,
                };
                state.cache.lock().expect("cache lock").insert(
                    key,
                    snapshot,
                    &generation,
                    state.config.cache_ttl,
                );
            }
        }
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(ReceiverStream::new(receiver)),
    )
        .into_response())
}

enum Source {
    Live {
        client: Client,
        credential: [u8; 32],
        viewer: Viewer,
        login: String,
        mode: &'static str,
    },
    Demo {
        viewer: Viewer,
        owner: OwnedRepositories,
    },
}

fn sync_timeout() -> ApiError {
    ApiError(
        StatusCode::GATEWAY_TIMEOUT,
        "Synchronization took longer than the configured time limit. Refresh to try again.".into(),
    )
}

async fn finish_stream(
    sender: &Sender,
    deadline: Instant,
    operation: impl Future<Output = Result<(), ApiError>>,
) -> Option<u64> {
    let result = tokio::select! {
        biased;
        _ = sender.closed() => return None,
        result = tokio::time::timeout_at(deadline, operation) => result.unwrap_or_else(|_| Err(sync_timeout())),
    };
    let fetched_at = result.as_ref().ok().map(|()| timestamp());
    let event = match result {
        Ok(()) => Event::Complete {
            fetched_at: fetched_at.expect("successful synchronization"),
        },
        Err(ApiError(status, message)) => Event::Error {
            message,
            status: status.as_u16(),
        },
    };
    // Disconnecting drops the operation and its in-flight GitHub requests.
    tokio::time::timeout(STREAM_FINISH_TIMEOUT, send(sender, event))
        .await
        .ok()?
        .ok()?;
    fetched_at
}

async fn stream_work(
    sender: &Sender,
    client: &Client,
    login: &str,
    repositories: &[Repository],
    kind: WorkKind,
) -> Result<(), Error> {
    let sender = sender.clone();
    client
        .work_items_with_progress(login, repositories, kind, move |items| {
            let sender = sender.clone();
            async move { send(&sender, Event::WorkItems { kind, items }).await }
        })
        .await?;
    Ok(())
}

async fn stream_live(
    sender: &Sender,
    client: &Client,
    viewer: Viewer,
    login: &str,
    mode: &'static str,
    priority: Section,
) -> Result<(), Error> {
    // Expose the authenticated identity before discovery, including when the
    // previously selected workspace is no longer accessible to this account.
    send(
        sender,
        Event::Context {
            viewer,
            owner: Owner {
                login: login.to_owned(),
                avatar_url: String::new(),
            },
            mode,
            cache_ttl_seconds: sender.cache_ttl_seconds,
            cache_age_seconds: 0,
            cached: false,
        },
    )
    .await?;
    let owner = client
        .repositories_with_progress(login, |page| async move {
            send(
                sender,
                Event::Repositories {
                    repositories: page.repositories.clone(),
                    total: page.total,
                    owner: Owner {
                        login: page.login.clone(),
                        avatar_url: page.avatar_url,
                    },
                },
            )
            .await?;
            // Work on the visible inbox starts after the first discovery page, not the last.
            if let Some(kind) = priority.work_kind() {
                stream_work(sender, client, &page.login, &page.repositories, kind).await?;
            }
            Ok(())
        })
        .await?;
    send(
        sender,
        Event::SectionComplete {
            section: Section::Repositories,
        },
    )
    .await?;
    if priority.work_kind().is_some() {
        send(sender, Event::SectionComplete { section: priority }).await?;
    }
    for kind in [WorkKind::Issues, WorkKind::Prs] {
        if Some(kind) != priority.work_kind() {
            stream_work(sender, client, &owner.login, &owner.repositories, kind).await?;
            send(
                sender,
                Event::SectionComplete {
                    section: kind.into(),
                },
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct Demo {
    viewer: Viewer,
    owner: OwnedRepositories,
}

#[derive(Deserialize)]
struct DemoWork {
    issues: Vec<WorkItem>,
    prs: Vec<WorkItem>,
}

static DEMO: LazyLock<Demo> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../tests/demo.json")).expect("valid demo fixture")
});
static DEMO_WORK: LazyLock<DemoWork> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../tests/work-items.json")).expect("valid work fixture")
});

async fn stream_demo(
    sender: &Sender,
    viewer: Viewer,
    owner: OwnedRepositories,
    priority: Section,
) -> Result<(), Error> {
    send(
        sender,
        Event::Context {
            viewer,
            owner: Owner {
                login: owner.login.clone(),
                avatar_url: owner.avatar_url.clone(),
            },
            mode: "demo",
            cache_ttl_seconds: sender.cache_ttl_seconds,
            cache_age_seconds: 0,
            cached: false,
        },
    )
    .await?;
    for repositories in owner.repositories.chunks(3) {
        send(
            sender,
            Event::Repositories {
                repositories: repositories.to_vec(),
                total: owner.repositories.len(),
                owner: Owner {
                    login: owner.login.clone(),
                    avatar_url: owner.avatar_url.clone(),
                },
            },
        )
        .await?;
        if let Some(kind) = priority.work_kind() {
            demo_work(sender, kind, Some(repositories)).await?;
        }
    }
    send(
        sender,
        Event::SectionComplete {
            section: Section::Repositories,
        },
    )
    .await?;
    if priority.work_kind().is_some() {
        send(sender, Event::SectionComplete { section: priority }).await?;
    }
    for kind in [WorkKind::Issues, WorkKind::Prs] {
        if Some(kind) != priority.work_kind() {
            demo_work(sender, kind, None).await?;
            send(
                sender,
                Event::SectionComplete {
                    section: kind.into(),
                },
            )
            .await?;
        }
    }
    Ok(())
}

async fn demo_work(
    sender: &Sender,
    kind: WorkKind,
    repositories: Option<&[Repository]>,
) -> Result<(), Error> {
    let mut items = match kind {
        WorkKind::Issues => DEMO_WORK.issues.clone(),
        WorkKind::Prs => DEMO_WORK.prs.clone(),
    };
    items.retain(|item| {
        repositories.is_none_or(|repos| repos.iter().any(|repo| repo.name == item.repository.name))
    });
    for items in items.chunks(10) {
        send(
            sender,
            Event::WorkItems {
                kind,
                items: items.to_vec(),
            },
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::ConnectInfo, http::Request};
    use std::{net::SocketAddr, sync::Arc};
    use tokio::sync::Semaphore;
    use tower::ServiceExt;

    fn state() -> AppState {
        AppState {
            mode: Mode::Demo,
            default_owner: None,
            allowed_users: vec![],
            requests: Arc::new(Semaphore::new(4)),
            config: crate::config::Config::default(),
            cache: Arc::default(),
        }
    }

    fn request(path: &str, peer: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header(header::HOST, "localhost:8080")
            .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn every_priority_streams_all_sections_with_actionable_batches() {
        for priority in ["repositories", "issues", "prs"] {
            let response = crate::app(state())
                .oneshot(request(
                    &format!("/api/sync?priority={priority}"),
                    "127.0.0.1:1000",
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "application/x-ndjson"
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()["x-accel-buffering"], "no");
            let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap();
            let events: Vec<serde_json::Value> = bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice(line).unwrap())
                .collect();
            assert_eq!(events.first().unwrap()["type"], "context");
            assert_eq!(events.last().unwrap()["type"], "complete");
            assert!(events.last().unwrap()["fetchedAt"].as_u64().unwrap() > 0);
            let completion: Vec<_> = events
                .iter()
                .filter(|event| event["type"] == "section-complete")
                .map(|event| event["section"].as_str().unwrap())
                .collect();
            assert_eq!(completion.len(), 3);
            for section in ["repositories", "issues", "prs"] {
                assert!(completion.contains(&section));
            }
            let repositories: Vec<_> = events
                .iter()
                .filter(|event| event["type"] == "repositories")
                .collect();
            assert!(repositories.len() > 1);
            let total: usize = repositories
                .iter()
                .map(|event| event["repositories"].as_array().unwrap().len())
                .sum();
            assert_eq!(total as u64, repositories[0]["total"].as_u64().unwrap());
            for (kind, count) in [("issues", 29), ("prs", 13)] {
                let items: Vec<_> = events
                    .iter()
                    .filter(|event| event["type"] == "work-items" && event["kind"] == kind)
                    .flat_map(|event| event["items"].as_array().unwrap())
                    .collect();
                assert_eq!(items.len(), count);
                for item in &items {
                    let number = item["number"].as_u64().unwrap();
                    assert!(
                        item["url"]
                            .as_str()
                            .unwrap()
                            .ends_with(&format!("/{number}"))
                    );
                    assert!(
                        item["repository"]["nameWithOwner"]
                            .as_str()
                            .unwrap()
                            .starts_with("studio/")
                    );
                    assert_ne!(item["repository"]["name"], "old-lab");
                }
                let ids: std::collections::HashSet<_> = items
                    .iter()
                    .map(|item| item["id"].as_str().unwrap())
                    .collect();
                assert_eq!(ids.len(), count);
                let complete = events
                    .iter()
                    .position(|event| {
                        event["type"] == "section-complete" && event["section"] == kind
                    })
                    .unwrap();
                assert!(
                    !events[complete + 1..]
                        .iter()
                        .any(|event| event["type"] == "work-items" && event["kind"] == kind)
                );
            }
            let first_work = events
                .iter()
                .position(|event| event["type"] == "work-items")
                .unwrap();
            let repos_complete = events
                .iter()
                .position(|event| {
                    event["type"] == "section-complete" && event["section"] == "repositories"
                })
                .unwrap();
            if priority == "repositories" {
                assert!(repos_complete < first_work);
            } else {
                assert_eq!(events[first_work]["kind"], priority);
                assert!(first_work < repos_complete);
                let other_kind = if priority == "issues" {
                    "prs"
                } else {
                    "issues"
                };
                let priority_complete = events
                    .iter()
                    .position(|event| {
                        event["type"] == "section-complete" && event["section"] == priority
                    })
                    .unwrap();
                assert!(
                    !events[..priority_complete]
                        .iter()
                        .any(|event| event["kind"] == other_kind)
                );
            }
        }
    }

    #[tokio::test]
    async fn stream_validates_scope_and_rejects_remote_local_mode() {
        for (path, peer, expected) in [
            (
                "/api/sync?priority=unknown",
                "127.0.0.1:1000",
                StatusCode::BAD_REQUEST,
            ),
            (
                "/api/sync?owner=bad/name",
                "127.0.0.1:1000",
                StatusCode::BAD_REQUEST,
            ),
            (
                "/api/sync?owner=missing",
                "127.0.0.1:1000",
                StatusCode::NOT_FOUND,
            ),
            ("/api/sync", "192.168.1.1:1000", StatusCode::FORBIDDEN),
        ] {
            let response = crate::app(state())
                .oneshot(request(path, peer))
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn pagination_error_and_timeout_never_certify_partial_results() {
        for timeout in [false, true] {
            let (channel, mut receiver) = mpsc::channel(8);
            let sender = Sender::new(channel, 1800);
            let operation = async {
                send(
                    &sender,
                    Event::WorkItems {
                        kind: WorkKind::Issues,
                        items: vec![],
                    },
                )
                .await?;
                if timeout {
                    std::future::pending::<()>().await;
                }
                Err(ApiError::from(Error::Pagination))
            };
            assert!(
                finish_stream(
                    &sender,
                    Instant::now() + Duration::from_millis(10),
                    operation,
                )
                .await
                .is_none()
            );
            drop(sender);
            let mut events = Vec::new();
            while let Some(line) = receiver.recv().await {
                events.push(serde_json::from_slice::<serde_json::Value>(&line.unwrap()).unwrap());
            }
            assert_eq!(events.len(), 2);
            assert_eq!(events[0]["type"], "work-items");
            assert_eq!(events[1]["type"], "error");
            assert_eq!(events[1]["status"], if timeout { 504 } else { 502 });
        }
    }

    #[tokio::test]
    async fn dropping_the_reader_cancels_pending_work_and_releases_capacity() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let (channel, receiver) = mpsc::channel(1);
        let sender = Sender::new(channel, 1800);
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let operation = async move {
                let _permit = permit;
                started.send(()).unwrap();
                std::future::pending::<Result<(), ApiError>>().await
            };
            finish_stream(
                &sender,
                Instant::now() + Duration::from_secs(120),
                operation,
            )
            .await;
        });
        ready.await.unwrap();
        assert_eq!(semaphore.available_permits(), 0);
        drop(receiver);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(semaphore.available_permits(), 1);
    }

    #[tokio::test]
    async fn streaming_keeps_the_request_permit_until_consumed_or_cancelled() {
        let state = state();
        let response = crate::app(state.clone())
            .oneshot(request("/api/sync", "127.0.0.1:1000"))
            .await
            .unwrap();
        assert_eq!(state.requests.available_permits(), 3);
        drop(response);
        let _permit = tokio::time::timeout(Duration::from_secs(1), state.requests.acquire_many(4))
            .await
            .unwrap()
            .unwrap();
        assert!(state.cache.lock().unwrap().entries.is_empty());
    }
    async fn events(state: &AppState, path: &str) -> Vec<serde_json::Value> {
        let response = crate::app(state.clone())
            .oneshot(request(path, "127.0.0.1:1000"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn complete_cache_replays_across_views_until_expiry_or_explicit_refresh() {
        let mut state = state();
        state.config.cache_ttl = Duration::from_secs(45);
        let first = events(&state, "/api/sync?priority=issues").await;
        assert_eq!(first[0]["cached"], false);
        assert_eq!(first[0]["cacheTtlSeconds"], 45);
        assert_eq!(first[0]["cacheAgeSeconds"], 0);
        {
            let mut cache = state.cache.lock().unwrap();
            assert_eq!(cache.entries.len(), 1);
            let snapshot = Arc::get_mut(&mut cache.entries[0].1).unwrap();
            snapshot.fetched_at = 123;
            snapshot.completed = Instant::now() - Duration::from_secs(10);
        }
        let cached = events(&state, "/api/sync?owner=STUDIO&priority=prs").await;
        assert_eq!(cached[0]["cached"], true);
        assert!(cached[0]["cacheAgeSeconds"].as_u64().unwrap() >= 10);
        assert_eq!(cached.last().unwrap()["fetchedAt"], 123);
        assert_eq!(&first[1..first.len() - 1], &cached[1..cached.len() - 1]);
        let fresh = events(&state, "/api/sync?priority=prs&refresh=true").await;
        assert_eq!(fresh[0]["cached"], false);
        assert_ne!(fresh.last().unwrap()["fetchedAt"], 123);
        {
            let mut cache = state.cache.lock().unwrap();
            Arc::get_mut(&mut cache.entries[0].1).unwrap().completed =
                Instant::now() - Duration::from_secs(45);
        }
        assert_eq!(events(&state, "/api/sync").await[0]["cached"], false);
        let mut proxy = state.clone();
        proxy.mode = Mode::Proxy;
        proxy.allowed_users = vec!["studio".into()];
        let response = crate::app(proxy)
            .oneshot(request("/api/sync", "127.0.0.1:1000"))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "a warm cache cannot bypass authentication"
        );
    }

    fn key() -> CacheKey {
        CacheKey {
            credential: Sha256::digest(b"test-session").into(),
            viewer: "alice".into(),
            owner: "team".into(),
            mode: "proxy",
        }
    }

    fn snapshot(bytes: usize) -> Snapshot {
        Snapshot {
            owner: Owner {
                login: "team".into(),
                avatar_url: String::new(),
            },
            lines: vec![],
            fetched_at: 1,
            completed: Instant::now(),
            started: Instant::now(),
            bytes,
        }
    }

    fn store(cache: &mut Cache, key: CacheKey, snapshot: Snapshot, ttl: Duration) {
        let (_, generation) = cache.lookup(&key, false, Instant::now(), ttl);
        cache.insert(key, snapshot, &generation, ttl);
    }

    #[test]
    fn cache_isolates_credentials_viewers_owners_and_modes_and_bounds_memory() {
        let mut cache = Cache::default();
        let ttl = Duration::from_secs(60);
        store(&mut cache, key(), snapshot(100), ttl);
        assert!(cache.lookup(&key(), false, Instant::now(), ttl).0.is_some());
        let mut variants = vec![key(); 4];
        variants[0].credential = Sha256::digest(b"another-session").into();
        variants[1].viewer = "bob".into();
        variants[2].owner = "other-team".into();
        variants[3].mode = "gh";
        for variant in variants {
            assert!(
                cache
                    .lookup(&variant, false, Instant::now(), ttl)
                    .0
                    .is_none()
            );
        }
        for index in 0..CACHE_MAX_ENTRIES + 2 {
            let mut key = key();
            key.owner = index.to_string();
            store(&mut cache, key, snapshot(100), ttl);
        }
        assert_eq!(cache.entries.len(), CACHE_MAX_ENTRIES);
        assert!(cache.lookup(&key(), false, Instant::now(), ttl).0.is_none());
        store(&mut cache, key(), snapshot(CACHE_MAX_ENTRY_BYTES + 1), ttl);
        assert!(cache.lookup(&key(), false, Instant::now(), ttl).0.is_none());
        for index in 0..10 {
            let mut key = key();
            key.owner = format!("large-{index}");
            store(&mut cache, key, snapshot(CACHE_MAX_ENTRY_BYTES), ttl);
        }
        assert!(
            cache
                .entries
                .iter()
                .map(|(_, value)| value.bytes)
                .sum::<usize>()
                <= CACHE_MAX_BYTES
        );
        cache.prune(Instant::now() + ttl, ttl);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn refresh_invalidates_only_matching_in_flight_writes_and_newer_results_win() {
        let mut cache = Cache::default();
        let ttl = Duration::from_secs(60);
        let (_, initial) = cache.lookup(&key(), false, Instant::now(), ttl);
        let (_, concurrent) = cache.lookup(&key(), false, Instant::now(), ttl);
        assert!(Arc::ptr_eq(&initial, &concurrent));
        let older = snapshot(100);
        let mut newer = snapshot(100);
        newer.fetched_at = 2;
        cache.insert(key(), newer, &initial, ttl);
        cache.insert(key(), older, &concurrent, ttl);
        assert_eq!(cache.entries[0].1.fetched_at, 2);

        let mut other = key();
        other.owner = "another-workspace".into();
        let (_, unrelated) = cache.lookup(&other, false, Instant::now(), ttl);
        let (_, refreshed) = cache.lookup(&key(), true, Instant::now(), ttl);
        cache.insert(key(), snapshot(100), &initial, ttl);
        assert!(cache.entries.is_empty());
        cache.insert(other.clone(), snapshot(100), &unrelated, ttl);
        assert!(
            cache.lookup(&other, false, Instant::now(), ttl).0.is_some(),
            "refreshing one workspace must not discard another workspace's completed fill"
        );
        cache.insert(key(), snapshot(100), &refreshed, ttl);
        assert_eq!(cache.entries.len(), 2);

        drop((initial, concurrent, unrelated, refreshed));
        cache.prune(Instant::now(), ttl);
        assert!(
            cache.generations.is_empty(),
            "completed requests must not retain credential generation records"
        );
    }
    #[tokio::test]
    async fn authenticated_context_is_available_even_when_discovery_fails() {
        let demo: serde_json::Value =
            serde_json::from_str(include_str!("../tests/demo.json")).unwrap();
        let viewer: Viewer = serde_json::from_value(demo["viewer"].clone()).unwrap();
        let (channel, mut receiver) = mpsc::channel(1);
        let sender = Sender::new(channel, 1800);
        // An invalid owner fails client-side without using network access.
        let result = stream_live(
            &sender,
            &Client::with_token_options("test-token", Default::default()).unwrap(),
            viewer.clone(),
            "invalid/owner",
            "gh",
            Section::Repositories,
        )
        .await;
        assert!(matches!(result, Err(Error::InvalidOwner)));
        let event: serde_json::Value =
            serde_json::from_slice(&receiver.recv().await.unwrap().unwrap()).unwrap();
        assert_eq!(event["type"], "context");
        assert_eq!(event["viewer"]["login"], viewer.login);
        assert_eq!(event["owner"]["login"], "invalid/owner");
        assert_eq!(event["cached"], false);
    }
}
