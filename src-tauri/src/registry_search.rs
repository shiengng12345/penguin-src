// Sonatype/npm registry package discovery for the installer's fuzzy search.
// Credentials never reach the webview: both commands read ~/.npmrc themselves
// (via registry::read_registry_connection) and talk to the registry with
// reqwest. Search endpoint strategy: try the standard npm search API first
// (Nexus 3 serves it on npm repos), fall back to the Nexus REST component
// search when the npm endpoint is missing/empty.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

const SEARCH_TIMEOUT_SECS: u64 = 15;
const NPM_SEARCH_PAGE_SIZE: usize = 250;
// 安全上限：防御异常 registry 无限翻页；@snsoft 实际包量远低于此。
const SEARCH_MAX_TOTAL: usize = 2000;
const SNSOFT_SCOPE: &str = "@snsoft";
const NEXUS_GROUP: &str = "snsoft";
const AUTH_HINT: &str = "请到 Settings → Package Registry 检查凭据";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RegistryPackage {
    pub name: String,
    pub latest_version: String,
    pub description: Option<String>,
    // dist-tags（去掉 latest）——团队按项目打 tag 发布
    // （如 kyc-merge-account / freespin-every-day-v3），搜索要能按它命中。
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PackageVersions {
    pub versions: Vec<String>,
    pub latest: Option<String>,
    // tag → 解析到的版本号（含 latest），版本选择器把 tag 放在最上面
    pub tags: HashMap<String, String>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

fn status_error(context: &str, status: reqwest::StatusCode) -> String {
    if status.as_u16() == 401 || status.as_u16() == 403 {
        format!("{context}: HTTP {status} 未授权 — {AUTH_HINT}")
    } else {
        format!("{context}: HTTP {status}")
    }
}

// snsoft 版本带 14 位 YYYYMMDDHHMMSS 构建时间戳；比较新旧以它为准。
fn version_stamp(version: &str) -> Option<u64> {
    let bytes = version.as_bytes();
    let mut run_start = None;
    let mut run_len = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if b.is_ascii_digit() {
            if run_len == 0 {
                run_start = Some(i);
            }
            run_len += 1;
            if run_len == 14 {
                let start = run_start?;
                // 恰好 14 位才算时间戳（后一位若还是数字则不是 14 位段）
                if bytes.get(i + 1).is_none_or(|nb| !nb.is_ascii_digit()) {
                    return version[start..=i].parse().ok();
                }
                // 段更长：跳过整段数字继续找
                run_len = 0;
                run_start = None;
            }
        } else {
            run_len = 0;
            run_start = None;
        }
    }
    None
}

pub(crate) fn sort_versions_desc(mut versions: Vec<String>) -> Vec<String> {
    versions.sort_by(|a, b| {
        let (sa, sb) = (version_stamp(a).unwrap_or(0), version_stamp(b).unwrap_or(0));
        sb.cmp(&sa).then_with(|| b.cmp(a))
    });
    versions
}

// "http://host:8081/repository/npm_hosted/" → "http://host:8081"
fn origin_of(registry_url: &str) -> Option<String> {
    let scheme_end = registry_url.find("://")?;
    let after_scheme = &registry_url[scheme_end + 3..];
    let host_end = after_scheme.find('/').unwrap_or(after_scheme.len());
    Some(format!(
        "{}{}",
        &registry_url[..scheme_end + 3],
        &after_scheme[..host_end]
    ))
}

// "http://host/repository/npm_hosted/" → "npm_hosted"
fn repository_of(registry_url: &str) -> Option<String> {
    let marker = "/repository/";
    let idx = registry_url.find(marker)?;
    let rest = &registry_url[idx + marker.len()..];
    let end = rest.find('/').unwrap_or(rest.len());
    let repo = &rest[..end];
    if repo.is_empty() {
        None
    } else {
        Some(repo.to_string())
    }
}

// ---- npm 标准搜索端点 ----

#[derive(Debug, Deserialize)]
struct NpmSearchResponse {
    #[serde(default)]
    objects: Vec<NpmSearchObject>,
}

#[derive(Debug, Deserialize)]
struct NpmSearchObject {
    package: NpmSearchPackage,
}

#[derive(Debug, Deserialize)]
struct NpmSearchPackage {
    name: String,
    version: String,
    #[serde(default)]
    description: Option<String>,
}

async fn npm_search_all(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
) -> Result<Vec<RegistryPackage>, String> {
    eprintln!("INFO npm_search_all - entry");
    let mut out: Vec<RegistryPackage> = Vec::new();
    let mut from = 0usize;
    loop {
        let url = format!(
            "{registry_url}-/v1/search?text=%40snsoft&size={NPM_SEARCH_PAGE_SIZE}&from={from}"
        );
        let resp = client
            .get(&url)
            .header("authorization", auth)
            .send()
            .await
            .map_err(|e| format!("npm search 请求失败: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_error("npm search", status));
        }
        let parsed: NpmSearchResponse = resp
            .json()
            .await
            .map_err(|e| format!("npm search 响应解析失败: {e}"))?;
        let batch = parsed.objects.len();
        for obj in parsed.objects {
            if obj.package.name.starts_with(SNSOFT_SCOPE) {
                out.push(RegistryPackage {
                    name: obj.package.name,
                    latest_version: obj.package.version,
                    description: obj.package.description,
                    tags: Vec::new(), // enrich_with_packuments 统一补
                });
            }
        }
        if batch < NPM_SEARCH_PAGE_SIZE || out.len() >= SEARCH_MAX_TOTAL {
            break;
        }
        from += batch;
    }
    eprintln!("INFO npm_search_all - exit count={}", out.len());
    Ok(out)
}

// ---- Nexus REST 组件搜索（回退） ----

#[derive(Debug, Deserialize)]
struct NexusSearchResponse {
    #[serde(default)]
    items: Vec<NexusComponent>,
    #[serde(rename = "continuationToken")]
    continuation_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NexusComponent {
    name: String,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

async fn nexus_search_all(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
) -> Result<Vec<RegistryPackage>, String> {
    eprintln!("INFO nexus_search_all - entry");
    let origin = origin_of(registry_url).ok_or("无法从 registry URL 推导主机地址")?;
    let repository = repository_of(registry_url)
        .ok_or("registry URL 不含 /repository/ 段，无法推导 Nexus 仓库名")?;

    // 同名包聚合出全部版本，再取最新版为列表展示版本
    let mut versions_by_name: HashMap<String, Vec<String>> = HashMap::new();
    let mut token: Option<String> = None;
    let mut fetched = 0usize;
    loop {
        let mut url = format!(
            "{origin}/service/rest/v1/search?format=npm&repository={repository}&group={NEXUS_GROUP}"
        );
        if let Some(ref t) = token {
            url.push_str("&continuationToken=");
            url.push_str(t);
        }
        let resp = client
            .get(&url)
            .header("authorization", auth)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Nexus search 请求失败: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_error("Nexus search", status));
        }
        let parsed: NexusSearchResponse = resp
            .json()
            .await
            .map_err(|e| format!("Nexus search 响应解析失败: {e}"))?;
        fetched += parsed.items.len();
        for item in parsed.items {
            // Nexus npm 组件: group="snsoft"（无 @），name 不带 scope；也有实例把
            // 完整 "@snsoft/x" 放进 name —— 两种都还原成完整包名。
            let full_name = if item.name.starts_with('@') {
                item.name
            } else {
                match item.group.as_deref() {
                    Some(g) if !g.is_empty() => format!("@{g}/{}", item.name),
                    _ => item.name,
                }
            };
            if !full_name.starts_with(SNSOFT_SCOPE) {
                continue;
            }
            if let Some(v) = item.version {
                versions_by_name.entry(full_name).or_default().push(v);
            }
        }
        token = parsed.continuation_token;
        if token.is_none() || fetched >= SEARCH_MAX_TOTAL {
            break;
        }
    }

    let mut out: Vec<RegistryPackage> = versions_by_name
        .into_iter()
        .map(|(name, versions)| {
            let sorted = sort_versions_desc(versions);
            RegistryPackage {
                name,
                latest_version: sorted.first().cloned().unwrap_or_default(),
                description: None,
                tags: Vec::new(), // enrich_with_packuments 统一补
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    eprintln!("INFO nexus_search_all - exit count={}", out.len());
    Ok(out)
}

// ---- 命令 ----

// 该 Nexus 的 npm 搜索端点一旦被发现返回空/失败，本进程内不再重试——
// 避免每次刷新都白等一趟（用户机器实测 /-/v1/search 返回 200 但 0 结果）。
static NPM_SEARCH_UNSUPPORTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub(crate) async fn registry_search_packages() -> Result<Vec<RegistryPackage>, String> {
    use std::sync::atomic::Ordering;
    eprintln!("INFO registry_search_packages - entry");
    let (registry_url, auth_b64) = crate::registry::read_registry_connection()
        .ok_or_else(|| format!("registry 未配置 — {AUTH_HINT}"))?;
    let client = http_client()?;
    let auth = format!("Basic {auth_b64}");

    let result = if NPM_SEARCH_UNSUPPORTED.load(Ordering::Relaxed) {
        nexus_search_all(&client, &registry_url, &auth).await
    } else {
        // 两个端点并行发起：npm 命中就用（快路径），否则用 Nexus 结果——
        // 串行「先试 npm 再回退」会把 npm 的等待时间白白加在总时长上。
        let (npm_res, nexus_res) = tokio::join!(
            npm_search_all(&client, &registry_url, &auth),
            nexus_search_all(&client, &registry_url, &auth),
        );
        match npm_res {
            Ok(list) if !list.is_empty() => Ok(list),
            other => {
                match &other {
                    Ok(_) => eprintln!(
                        "WARN registry_search_packages - npm search 返回空，本进程内后续直走 Nexus"
                    ),
                    Err(err) => eprintln!(
                        "WARN registry_search_packages - npm search 失败 ({err})，本进程内后续直走 Nexus"
                    ),
                }
                NPM_SEARCH_UNSUPPORTED.store(true, Ordering::Relaxed);
                nexus_res
            }
        }
    };
    let mut list = result?;
    list.sort_by(|a, b| a.name.cmp(&b.name));
    enrich_with_packuments(&client, &registry_url, &auth, &mut list).await;
    eprintln!(
        "INFO registry_search_packages - exit count={}",
        list.len()
    );
    Ok(list)
}

#[derive(Debug, Deserialize)]
struct Packument {
    #[serde(default)]
    versions: HashMap<String, serde_json::Value>,
    #[serde(rename = "dist-tags", default)]
    dist_tags: HashMap<String, String>,
    #[serde(default)]
    description: Option<String>,
}

async fn fetch_packument(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
    name: &str,
) -> Result<Packument, String> {
    // scope 斜线必须编码，与 npm 客户端行为一致
    let encoded = name.replacen('/', "%2F", 1);
    let url = format!("{registry_url}{encoded}");
    let resp = client
        .get(&url)
        .header("authorization", auth)
        .send()
        .await
        .map_err(|e| format!("packument 请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(status_error("packument", status));
    }
    resp.json()
        .await
        .map_err(|e| format!("packument 解析失败: {e}"))
}

const PACKUMENT_CONCURRENCY: usize = 12;

// 列表补全：并发拉全部包的 packument，把 dist-tags（项目标签，如
// kyc-merge-account）灌进搜索索引，并用 dist-tags.latest 修正展示版本。
// 单包失败不影响整体——该包 tags 留空，仍可按名搜索。
async fn enrich_with_packuments(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
    list: &mut [RegistryPackage],
) {
    for chunk in list.chunks_mut(PACKUMENT_CONCURRENCY) {
        let mut set = tokio::task::JoinSet::new();
        for (i, pkg) in chunk.iter().enumerate() {
            let client = client.clone();
            let registry_url = registry_url.to_string();
            let auth = auth.to_string();
            let name = pkg.name.clone();
            set.spawn(async move {
                let result = fetch_packument(&client, &registry_url, &auth, &name).await;
                (i, result)
            });
        }
        while let Some(joined) = set.join_next().await {
            let Ok((i, result)) = joined else { continue };
            let Ok(packument) = result else { continue };
            let pkg = &mut chunk[i];
            let mut tags: Vec<String> = packument
                .dist_tags
                .keys()
                .filter(|k| k.as_str() != "latest")
                .cloned()
                .collect();
            tags.sort();
            pkg.tags = tags;
            if let Some(latest) = packument.dist_tags.get("latest") {
                pkg.latest_version = latest.clone();
            }
            if pkg.description.is_none() {
                pkg.description = packument.description.clone();
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn registry_package_versions(name: String) -> Result<PackageVersions, String> {
    eprintln!("INFO registry_package_versions - entry name={name}");
    if !name.starts_with(SNSOFT_SCOPE) || !name.contains('/') {
        return Err(format!("非法包名: {name}"));
    }
    let (registry_url, auth_b64) = crate::registry::read_registry_connection()
        .ok_or_else(|| format!("registry 未配置 — {AUTH_HINT}"))?;
    let client = http_client()?;
    let auth = format!("Basic {auth_b64}");
    let parsed = fetch_packument(&client, &registry_url, &auth, &name).await?;
    let versions = sort_versions_desc(parsed.versions.into_keys().collect());
    let latest = parsed.dist_tags.get("latest").cloned();
    eprintln!(
        "INFO registry_package_versions - exit versions={} tags={}",
        versions.len(),
        parsed.dist_tags.len()
    );
    Ok(PackageVersions {
        versions,
        latest,
        tags: parsed.dist_tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_stamp_extracts_14_digit_build_time() {
        assert_eq!(
            version_stamp("2.1.1-20260624172317"),
            Some(20260624172317)
        );
        assert_eq!(version_stamp("1.0.0"), None);
        // 15 位数字段不是构建戳
        assert_eq!(version_stamp("1.0.0-202606241723170"), None);
    }

    #[test]
    fn sort_versions_desc_prefers_newer_stamp_then_string() {
        let sorted = sort_versions_desc(vec![
            "2.1.1-20260101000000".to_string(),
            "2.1.1-20260624172317".to_string(),
            "1.0.0".to_string(),
            "1.2.0".to_string(),
        ]);
        assert_eq!(
            sorted,
            vec![
                "2.1.1-20260624172317",
                "2.1.1-20260101000000",
                "1.2.0",
                "1.0.0",
            ]
        );
    }

    #[test]
    fn origin_and_repository_derive_from_registry_url() {
        let url = "http://sonatype.client88.me/repository/npm_hosted/";
        assert_eq!(
            origin_of(url).as_deref(),
            Some("http://sonatype.client88.me")
        );
        assert_eq!(repository_of(url).as_deref(), Some("npm_hosted"));
        assert_eq!(repository_of("http://host/npm/"), None);
    }
}
