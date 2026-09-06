//! Read-only GitHub access through github-rust, with Forge's stable response types.
//! Authentication is explicit; only CLI credential discovery reads the local gh account.
use futures_util::{Stream, TryStreamExt};
use github_rust::{
    ErrorKind, FetchOptions, GitHubClient, GitHubError, GitHubService, RepositoryCoordinates,
};
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::pin, process::Stdio, sync::Arc, time::Duration};
use tokio::{process::Command, time::timeout};

// Intentionally no Debug: client credentials must not appear in application logs.
#[derive(Clone)]
pub struct Client {
    service: Arc<GitHubService>,
}

impl Client {
    pub fn with_token_options(
        token: impl Into<String>,
        options: ClientOptions,
    ) -> Result<Self, Error> {
        let token = token.into();
        if token.is_empty() || token.len() > 8192 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(Error::Unauthorized);
        }
        let http = reqwest::Client::builder()
            .timeout(options.request_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Upstream)?;
        let client = GitHubClient::builder()
            .token(token.into())
            .http_client(http)
            .build()
            .map_err(Error::from)?;
        let service = GitHubService::with_client(client)
            .with_fetch_options(FetchOptions {
                max_concurrent_repositories: options.max_concurrent_repositories.get(),
                ..FetchOptions::default()
            })
            .map_err(Error::from)?;
        Ok(Self {
            service: Arc::new(service),
        })
    }

    /// Resolve the active CLI credential once so an in-flight request cannot change accounts.
    pub async fn gh_token(request_timeout: Duration) -> Result<String, Error> {
        let output = timeout(
            request_timeout,
            Command::new("gh")
                .args(["auth", "token", "--hostname", "github.com"])
                .env("GH_PROMPT_DISABLED", "1")
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Cli)?;
        if !output.status.success() {
            return Err(Error::Unauthorized);
        }
        String::from_utf8(output.stdout)
            .map(|token| token.trim().to_owned())
            .map_err(|_| Error::Unauthorized)
    }

    pub async fn viewer(&self) -> Result<Viewer, Error> {
        let viewer = self.service.get_viewer().await?;
        Ok(Viewer {
            login: viewer.account.login,
            name: viewer.account.name,
            avatar_url: viewer.account.avatar_url,
            organizations: viewer.organizations.into_iter().map(Into::into).collect(),
        })
    }

    /// Batches remain provisional until successful completion. Callback errors cancel traversal.
    pub async fn repositories_with_progress<F, Fut>(
        &self,
        login: &str,
        mut progress: F,
    ) -> Result<OwnedRepositories, Error>
    where
        F: FnMut(RepositoryPage) -> Fut + Send,
        Fut: Future<Output = Result<(), Error>> + Send,
    {
        validate_owner(login)?;
        let mut pages = pin!(self.service.get_owned_repository_pages(login));
        let mut owner: Option<OwnedRepositories> = None;
        while let Some(page) = pages.try_next().await? {
            let page: RepositoryPage = page.into();
            let owner = owner.get_or_insert_with(|| OwnedRepositories {
                login: page.login.clone(),
                avatar_url: page.avatar_url.clone(),
                repositories: Vec::new(),
            });
            owner.repositories.extend(page.repositories.iter().cloned());
            progress(page).await?;
        }
        // The dependency yields an owner page even for an empty account.
        let mut owner = owner.ok_or(Error::Upstream)?;
        owner
            .repositories
            .sort_by(|a, b| a.name_with_owner.cmp(&b.name_with_owner));
        Ok(owner)
    }

    /// Only active repositories with open items enter the inbox. The dependency handles pagination,
    /// bounded concurrency and cancellation; Forge also rejects newly archived repositories.
    pub async fn work_items_with_progress<F, Fut>(
        &self,
        login: &str,
        repositories: &[Repository],
        kind: WorkKind,
        progress: F,
    ) -> Result<Vec<WorkItem>, Error>
    where
        F: FnMut(Vec<WorkItem>) -> Fut + Send,
        Fut: Future<Output = Result<(), Error>> + Send,
    {
        validate_owner(login)?;
        let scopes = repositories
            .iter()
            .filter(|repo| {
                !repo.is_archived
                    && match kind {
                        WorkKind::Issues => repo.issues.total_count > 0,
                        WorkKind::Prs => repo.pull_requests.total_count > 0,
                    }
            })
            .map(|repo| {
                if !repo
                    .name_with_owner
                    .eq_ignore_ascii_case(&format!("{login}/{}", repo.name))
                {
                    return Err(Error::Pagination);
                }
                validate_repository(&repo.name)?;
                RepositoryCoordinates::new(login, &repo.name).map_err(Error::from)
            })
            .collect::<Result<Vec<_>, _>>()?;
        match kind {
            WorkKind::Issues => {
                collect_work_pages(self.service.get_open_issue_pages(&scopes), progress).await
            }
            WorkKind::Prs => {
                collect_work_pages(self.service.get_open_pull_request_pages(&scopes), progress)
                    .await
            }
        }
    }
}

async fn collect_work_pages<S, T, F, Fut>(pages: S, mut progress: F) -> Result<Vec<WorkItem>, Error>
where
    S: Stream<Item = github_rust::Result<github_rust::WorkItemPage<T>>> + Send,
    T: Into<WorkItem> + Send,
    F: FnMut(Vec<WorkItem>) -> Fut + Send,
    Fut: Future<Output = Result<(), Error>> + Send,
{
    let mut pages = pin!(pages);
    let mut items = Vec::new();
    while let Some(page) = pages.try_next().await? {
        if page.repository.is_archived {
            return Err(Error::Pagination);
        }
        let batch: Vec<_> = page.items.into_iter().map(Into::into).collect();
        items.extend(batch.iter().cloned());
        progress(batch).await?;
    }
    items.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(items)
}

impl From<GitHubError> for Error {
    fn from(error: GitHubError) -> Self {
        // Upstream messages can contain request inputs or credentials. Expose only our fixed copy.
        match error.kind() {
            ErrorKind::Authentication => Self::Unauthorized,
            ErrorKind::Permission => Self::Forbidden,
            ErrorKind::RateLimit => Self::RateLimited,
            ErrorKind::Timeout => Self::Timeout,
            ErrorKind::NotFound => Self::NotFound,
            ErrorKind::Pagination => Self::Pagination,
            _ => Self::Upstream,
        }
    }
}
#[derive(Clone)]
pub struct ClientOptions {
    pub request_timeout: Duration,
    pub max_concurrent_repositories: std::num::NonZeroUsize,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            max_concurrent_repositories: std::num::NonZeroUsize::new(4)
                .expect("positive concurrency"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("GitHub authentication expired or missing. Reconnect with GitHub.")]
    Unauthorized,
    #[error("GitHub denied the request. Check permissions, organization SSO and rate limits.")]
    Forbidden,
    #[error("GitHub rate limit reached. Try again later.")]
    RateLimited,
    #[error("GitHub is unavailable or returned an invalid response.")]
    Upstream,
    #[error("GitHub CLI failed. Run gh auth status and check network access.")]
    Cli,
    #[error("GitHub did not respond within the configured time limit.")]
    Timeout,
    #[error("This GitHub account or organization is unavailable.")]
    NotFound,
    #[error("Invalid GitHub account name.")]
    InvalidOwner,
    #[error("Invalid GitHub repository name.")]
    InvalidRepository,
    #[error("GitHub data is incomplete or changed during synchronization. Refresh to try again.")]
    Pagination,
}

pub fn validate_owner(login: &str) -> Result<(), Error> {
    if login.is_empty()
        || login.len() > 39
        || login.starts_with('-')
        || login.ends_with('-')
        || !login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(Error::InvalidOwner);
    }
    Ok(())
}

pub fn validate_repository(name: &str) -> Result<(), Error> {
    if name.is_empty()
        || name.len() > 100
        || matches!(name, "." | "..")
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(Error::InvalidRepository);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkKind {
    Issues,
    Prs,
}

pub use github_rust::{Actor as WorkAccount, Label, ReviewDecision};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRepository {
    pub name: String,
    pub name_with_owner: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub author: Option<WorkAccount>,
    pub repository: WorkRepository,
    pub labels: Vec<Label>,
    pub assignees: Vec<WorkAccount>,
    pub comments: u64,
    pub is_draft: bool,
    pub review_decision: Option<ReviewDecision>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub organizations: Vec<Account>,
}

#[derive(Clone, Debug)]
pub struct RepositoryPage {
    pub login: String,
    pub avatar_url: String,
    pub repositories: Vec<Repository>,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedRepositories {
    pub login: String,
    pub avatar_url: String,
    pub repositories: Vec<Repository>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub name: String,
    pub name_with_owner: String,
    pub description: Option<String>,
    pub url: String,
    pub is_private: bool,
    pub is_fork: bool,
    pub is_archived: bool,
    pub stargazer_count: u64,
    pub fork_count: u64,
    pub pushed_at: Option<String>,
    pub updated_at: String,
    pub primary_language: Option<Language>,
    pub issues: Count,
    pub pull_requests: Count,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Language {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub total_count: u64,
}

impl From<github_rust::Account> for Account {
    fn from(account: github_rust::Account) -> Self {
        Self {
            login: account.login,
            name: account.name,
            avatar_url: account.avatar_url,
        }
    }
}
impl From<github_rust::RepositoryPage> for RepositoryPage {
    fn from(page: github_rust::RepositoryPage) -> Self {
        Self {
            login: page.owner.login,
            avatar_url: page.owner.avatar_url,
            total: page.total_count,
            repositories: page.repositories.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<github_rust::RepositorySummary> for Repository {
    fn from(repo: github_rust::RepositorySummary) -> Self {
        Self {
            name: repo.name,
            name_with_owner: repo.name_with_owner,
            description: repo.description,
            url: repo.url,
            is_private: repo.is_private,
            is_fork: repo.is_fork,
            is_archived: repo.is_archived,
            stargazer_count: repo.stargazer_count.into(),
            fork_count: repo.fork_count.into(),
            pushed_at: repo.pushed_at.map(|date| date.to_rfc3339()),
            updated_at: repo.updated_at.to_rfc3339(),
            primary_language: repo.primary_language.map(|language| Language {
                name: language.name,
                color: language.color,
            }),
            issues: Count {
                total_count: repo.open_issue_count.into(),
            },
            pull_requests: Count {
                total_count: repo.open_pull_request_count.into(),
            },
        }
    }
}
impl From<github_rust::Issue> for WorkItem {
    fn from(item: github_rust::Issue) -> Self {
        Self {
            id: item.node_id,
            number: item.number,
            title: item.title,
            url: item.url,
            created_at: item.created_at.to_rfc3339(),
            updated_at: item.updated_at.to_rfc3339(),
            author: item.author,
            repository: WorkRepository {
                name: item.repository.name,
                name_with_owner: item.repository.name_with_owner,
            },
            labels: item.labels,
            assignees: item.assignees,
            comments: item.comment_count.into(),
            is_draft: false,
            review_decision: None,
        }
    }
}
impl From<github_rust::PullRequest> for WorkItem {
    fn from(item: github_rust::PullRequest) -> Self {
        Self {
            id: item.node_id,
            number: item.number,
            title: item.title,
            url: item.url,
            created_at: item.created_at.to_rfc3339(),
            updated_at: item.updated_at.to_rfc3339(),
            author: item.author,
            repository: WorkRepository {
                name: item.repository.name,
                name_with_owner: item.repository.name_with_owner,
            },
            labels: item.labels,
            assignees: item.assignees,
            comments: item.comment_count.into(),
            is_draft: item.is_draft,
            review_decision: item.review_decision,
        }
    }
}

#[cfg(test)]
mod tests;
