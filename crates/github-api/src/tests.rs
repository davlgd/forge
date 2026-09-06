use super::*;
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

// Exercise the published dependency's HTTP parsing and traversal, using fictional responses.
struct Api {
    client: Client,
    requests: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl Api {
    async fn start(responses: Vec<Value>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/graphql", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            let mut responses = responses.into_iter();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (body_start, length) = loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0, "HTTP request ended before its headers");
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while bytes.len() < body_start + length {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0, "HTTP request ended before its body");
                    bytes.extend_from_slice(&buffer[..count]);
                }
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap());
                let body = responses
                    .next()
                    .unwrap_or_else(|| json!({"errors": [{"message": "Unexpected request"}]}))
                    .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let client = GitHubClient::builder()
            .token("fictional-test-token".into())
            .graphql_url(endpoint)
            .http_client(http)
            .build()
            .unwrap();
        let service = GitHubService::with_client(client)
            .with_fetch_options(FetchOptions {
                max_concurrent_repositories: 1,
                ..FetchOptions::default()
            })
            .unwrap();
        Self {
            client: Client {
                service: Arc::new(service),
            },
            requests,
            task,
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn connection(nodes: Vec<Value>, total: usize, next: Option<&str>) -> Value {
    json!({
        "nodes": nodes, "totalCount": total,
        "pageInfo": {"hasNextPage": next.is_some(), "endCursor": next}
    })
}

fn repository_node(number: usize) -> Value {
    json!({
        "id": format!("R_{number}"), "name": format!("project-{number}"),
        "nameWithOwner": format!("octo/project-{number}"), "description": "A fictional project",
        "url": format!("https://github.com/octo/project-{number}"),
        "isPrivate": true, "isFork": false, "isArchived": false,
        "stargazerCount": 42, "forkCount": 3,
        "pushedAt": null, "updatedAt": "2026-09-01T10:00:00Z",
        "primaryLanguage": {"name": "Rust", "color": "#dea584"},
        "issues": {"totalCount": 101}, "pullRequests": {"totalCount": 2}
    })
}

fn repositories(nodes: Vec<Value>, total: usize, next: Option<&str>) -> Value {
    json!({"data": {"repositoryOwner": {
        "id": "U_octo", "login": "octo", "name": "Octo",
        "avatarUrl": "https://avatars.example/octo",
        "repositories": connection(nodes, total, next)
    }}})
}

fn repository() -> Repository {
    serde_json::from_value(repository_node(1)).unwrap()
}

fn item(number: usize, kind: WorkKind) -> Value {
    let route = if kind == WorkKind::Issues {
        "issues"
    } else {
        "pull"
    };
    json!({
        "id": format!("I_{number}"), "number": number, "title": format!("Fix problem {number}"),
        "url": format!("https://github.com/octo/project-1/{route}/{number}"),
        "createdAt": "2026-09-01T09:00:00Z", "updatedAt": "2026-09-01T10:00:00Z",
        "author": if number == 1 { Value::Null } else { json!({"login": "octo"}) },
        "labels": {"totalCount": 1, "nodes": [{"name": "bug", "color": "d73a4a"}]},
        "assignees": {"totalCount": 1, "nodes": [{"login": "octo"}]},
        "comments": {"totalCount": 7}, "isDraft": true, "reviewDecision": "CHANGES_REQUESTED"
    })
}

fn work_page(kind: WorkKind, nodes: Vec<Value>, total: usize, next: Option<&str>) -> Value {
    let field = if kind == WorkKind::Issues {
        "issues"
    } else {
        "pullRequests"
    };
    json!({"data": {"repository": {
        "id": "R_1", "name": "project-1", "nameWithOwner": "octo/project-1",
        "isArchived": false, field: connection(nodes, total, next)
    }}})
}

#[tokio::test]
async fn viewer_and_repository_pages_keep_the_dashboard_contract() {
    let viewer = json!({"data": {"viewer": {
        "id": "U_octo", "login": "octo", "name": "Octo",
        "avatarUrl": "https://avatars.example/octo",
        "organizations": connection(vec![json!({
            "id": "O_team", "login": "team", "name": null,
            "avatarUrl": "https://avatars.example/team"
        })], 1, None)
    }}});
    let api = Api::start(vec![
        viewer,
        repositories(
            (1..=100).map(repository_node).collect(),
            101,
            Some("repo-100"),
        ),
        repositories(vec![repository_node(101)], 101, None),
    ])
    .await;
    let viewer = api.client.viewer().await.unwrap();
    assert_eq!(viewer.login, "octo");
    assert_eq!(viewer.name.as_deref(), Some("Octo"));
    assert_eq!(viewer.organizations[0].login, "team");
    let sizes = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&sizes);
    let owner = api
        .client
        .repositories_with_progress("octo", move |page| {
            assert_eq!(page.login, "octo");
            assert_eq!(page.total, 101);
            observed.lock().unwrap().push(page.repositories.len());
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
    assert_eq!(*sizes.lock().unwrap(), [100, 1]);
    assert_eq!(owner.repositories.len(), 101);
    let serialized = serde_json::to_value(&owner.repositories[0]).unwrap();
    assert_eq!(serialized["issues"]["totalCount"], 101);
    assert_eq!(serialized["pullRequests"]["totalCount"], 2);
    assert_eq!(serialized["primaryLanguage"]["name"], "Rust");
    assert_eq!(serialized["stargazerCount"], 42);
    assert_eq!(serialized["isPrivate"], true);
    assert!(serialized["pushedAt"].is_null());
    assert_eq!(api.requests()[2]["variables"]["cursor"], "repo-100");
}

#[tokio::test]
async fn issue_and_pull_request_inboxes_follow_every_page() {
    for kind in [WorkKind::Issues, WorkKind::Prs] {
        let api = Api::start(vec![
            work_page(
                kind,
                (1..=100).map(|n| item(n, kind)).collect(),
                101,
                Some("item-100"),
            ),
            work_page(kind, vec![item(101, kind)], 101, None),
        ])
        .await;
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&sizes);
        let items = api
            .client
            .work_items_with_progress("octo", &[repository()], kind, move |page| {
                observed.lock().unwrap().push(page.len());
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
        assert_eq!(*sizes.lock().unwrap(), [100, 1]);
        assert_eq!(items.len(), 101);
        let first = items.iter().find(|item| item.number == 1).unwrap();
        assert!(first.author.is_none());
        assert_eq!(first.repository.name_with_owner, "octo/project-1");
        assert_eq!(first.labels[0].name, "bug");
        assert_eq!(first.assignees[0].login, "octo");
        assert_eq!(first.comments, 7);
        assert_eq!(first.is_draft, kind == WorkKind::Prs);
        assert_eq!(
            first.review_decision,
            (kind == WorkKind::Prs).then_some(ReviewDecision::ChangesRequested)
        );
        let route = if kind == WorkKind::Issues {
            "issues"
        } else {
            "pull"
        };
        assert_eq!(
            first.url,
            format!("https://github.com/octo/project-1/{route}/1")
        );
        assert_eq!(api.requests()[1]["variables"]["cursor"], "item-100");
        assert_eq!(
            api.requests()[0]["variables"]["issues"],
            kind == WorkKind::Issues
        );
    }
}

#[tokio::test]
async fn callback_errors_cancel_traversal_without_losing_the_original_error() {
    let api = Api::start(vec![repositories(
        vec![repository_node(1)],
        2,
        Some("next"),
    )])
    .await;
    let error = api
        .client
        .repositories_with_progress("octo", |_| async { Err(Error::Timeout) })
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Timeout));
    assert_eq!(api.requests().len(), 1);

    for kind in [WorkKind::Issues, WorkKind::Prs] {
        let api = Api::start(vec![work_page(kind, vec![item(1, kind)], 2, Some("next"))]).await;
        let error = api
            .client
            .work_items_with_progress("octo", &[repository()], kind, |_| async {
                Err(Error::Forbidden)
            })
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Forbidden));
        assert_eq!(api.requests().len(), 1);
    }
}

#[tokio::test]
async fn archived_empty_and_foreign_repository_scopes_do_not_send_requests() {
    let api = Api::start(vec![]).await;
    let mut archived = repository();
    archived.is_archived = true;
    let mut empty = repository();
    empty.issues.total_count = 0;
    let result = api
        .client
        .work_items_with_progress("octo", &[archived, empty], WorkKind::Issues, |_| async {
            panic!("Excluded repositories must not produce a page")
        })
        .await
        .unwrap();
    assert!(result.is_empty());
    let mut foreign = repository();
    foreign.name_with_owner = "another/project-1".into();
    let error = api
        .client
        .work_items_with_progress("octo", &[foreign], WorkKind::Issues, |_| async { Ok(()) })
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Pagination));
    assert!(api.requests().is_empty());
}

#[tokio::test]
async fn repositories_archived_during_sync_are_rejected_before_progress() {
    for kind in [WorkKind::Issues, WorkKind::Prs] {
        let mut page = work_page(kind, vec![item(1, kind)], 1, None);
        page["data"]["repository"]["isArchived"] = json!(true);
        let api = Api::start(vec![page]).await;
        let error = api
            .client
            .work_items_with_progress("octo", &[repository()], kind, |_| async {
                panic!("Archived repository must not enter the inbox")
            })
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Pagination));
    }
}

#[tokio::test]
async fn partial_graphql_responses_never_expose_upstream_messages_or_emit_pages() {
    let mut page = repositories(vec![repository_node(1)], 1, None);
    page["errors"] = json!([{ "message": "private-repository fictional-test-token" }]);
    let api = Api::start(vec![page]).await;
    let error = api
        .client
        .repositories_with_progress("octo", |_| async {
            panic!("Partial GraphQL data must not enter the cache")
        })
        .await
        .unwrap_err();
    assert!(matches!(error, Error::Upstream));
    assert_eq!(
        error.to_string(),
        "GitHub is unavailable or returned an invalid response."
    );
}

#[tokio::test]
async fn incomplete_metadata_and_foreign_responses_never_enter_the_inbox() {
    for kind in [WorkKind::Issues, WorkKind::Prs] {
        let field = if kind == WorkKind::Issues {
            "issues"
        } else {
            "pullRequests"
        };
        for invalid in ["labels", "assignees", "count", "owner"] {
            let mut page = work_page(kind, vec![item(1, kind)], 1, None);
            let repo = &mut page["data"]["repository"];
            match invalid {
                "labels" | "assignees" => {
                    repo[field]["nodes"][0][invalid]["totalCount"] = json!(2);
                }
                "count" => repo[field]["totalCount"] = json!(2),
                "owner" => repo["nameWithOwner"] = json!("another/project-1"),
                _ => unreachable!(),
            }
            let api = Api::start(vec![page]).await;
            let error = api
                .client
                .work_items_with_progress("octo", &[repository()], kind, |_| async {
                    panic!("An incomplete or foreign page must not enter the inbox")
                })
                .await
                .unwrap_err();
            assert!(matches!(error, Error::Pagination), "{kind:?}: {invalid}");
        }
    }
}

#[tokio::test]
async fn invalid_final_repository_pages_leave_the_snapshot_incomplete() {
    for final_page in [
        repositories(vec![repository_node(1)], 2, None),
        repositories(vec![repository_node(2)], 3, None),
        repositories(vec![], 2, None),
    ] {
        let api = Api::start(vec![
            repositories(vec![repository_node(1)], 2, Some("next")),
            final_page,
        ])
        .await;
        let pages = Arc::new(Mutex::new(0));
        let observed = Arc::clone(&pages);
        let result = api
            .client
            .repositories_with_progress("octo", move |_| {
                *observed.lock().unwrap() += 1;
                std::future::ready(Ok(()))
            })
            .await;
        assert!(matches!(result, Err(Error::Pagination)));
        assert_eq!(*pages.lock().unwrap(), 1);
        assert_eq!(api.requests().len(), 2);
    }
}

#[tokio::test]
async fn invalid_request_scopes_are_rejected_before_network_access() {
    let api = Api::start(vec![]).await;
    for owner in ["", "-octo", "octo-", "octo/project", "octo\n", "octo;echo"] {
        assert!(matches!(
            api.client
                .repositories_with_progress(owner, |_| async { Ok(()) })
                .await,
            Err(Error::InvalidOwner)
        ));
    }
    for name in ["", ".", "..", "a/b", "a\n", "a?b", "a;b"] {
        let mut repo = repository();
        repo.name = name.into();
        repo.name_with_owner = format!("octo/{name}");
        assert!(matches!(
            api.client
                .work_items_with_progress("octo", &[repo], WorkKind::Issues, |_| async { Ok(()) })
                .await,
            Err(Error::InvalidRepository)
        ));
    }
    assert!(api.requests().is_empty());
}

#[tokio::test]
async fn graphql_error_categories_remain_actionable_and_sanitized() {
    for (kind, expected) in [
        ("RATE_LIMITED", Error::RateLimited),
        ("UNAUTHORIZED", Error::Unauthorized),
        ("UNAUTHENTICATED", Error::Unauthorized),
        ("FORBIDDEN", Error::Forbidden),
        ("INSUFFICIENT_SCOPES", Error::Forbidden),
        ("NOT_FOUND", Error::NotFound),
        ("INTERNAL", Error::Upstream),
        ("SOMETHING_NEW", Error::Upstream),
    ] {
        let mut page = repositories(vec![repository_node(1)], 1, None);
        page["errors"] = json!([{
            "type": kind, "message": "private-repository fictional-test-token"
        }]);
        let api = Api::start(vec![page]).await;
        let error = api
            .client
            .repositories_with_progress("octo", |_| async {
                panic!("GraphQL errors must invalidate even otherwise complete data")
            })
            .await
            .unwrap_err();
        assert_eq!(
            std::mem::discriminant(&error),
            std::mem::discriminant(&expected),
            "{kind}"
        );
        assert_eq!(error.to_string(), expected.to_string());
        assert!(!format!("{error:?}").contains("fictional-test-token"));
        assert_eq!(api.requests().len(), 1);
    }
}

#[test]
fn malformed_tokens_are_rejected_and_length_limit_is_inclusive() {
    for token in [
        "",
        " ",
        "token with space",
        "token\n",
        "token\r",
        "token\t",
        "token\0",
        "tökén",
    ] {
        assert!(matches!(
            Client::with_token_options(token, ClientOptions::default()),
            Err(Error::Unauthorized)
        ));
    }
    assert!(matches!(
        Client::with_token_options("x".repeat(8193), ClientOptions::default()),
        Err(Error::Unauthorized)
    ));
    assert!(Client::with_token_options("x".repeat(8192), ClientOptions::default()).is_ok());
}

#[tokio::test]
async fn page_stream_consumers_can_borrow_state_in_send_tasks() {
    let api = Api::start(vec![repositories(vec![repository_node(1)], 1, None)]).await;
    let client = api.client.clone();
    tokio::spawn(async move {
        let mut counts = Vec::new();
        let label = String::from("borrowed");
        let borrowed = &label;
        let operation = client.repositories_with_progress("octo", |page| {
            counts.push(page.repositories.len());
            async move {
                tokio::task::yield_now().await;
                assert_eq!(borrowed, "borrowed");
                Ok(())
            }
        });
        operation.await.unwrap();
        assert_eq!(counts, [1]);
    })
    .await
    .unwrap();
}
