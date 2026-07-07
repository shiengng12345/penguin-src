// Sonatype/npm registry package discovery for the installer's fuzzy search.
// Credentials never reach the webview: both commands read ~/.npmrc themselves
// (via registry::read_registry_connection) and talk to the registry with
// reqwest. Search endpoint strategy: try the standard npm search API first
// (Nexus 3 serves it on npm repos), fall back to the Nexus REST component
// search when the npm endpoint is missing/empty.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::Emitter;

// 首拉流式事件：Nexus 每翻一页，把该页新出现的包名推给前端先行展示，
// 用户不必等整个爬取结束才能开始搜索。
const DISCOVERED_EVENT: &str = "registry-search:discovered";
const ENRICHED_EVENT: &str = "registry-search:enriched";

const SEARCH_TIMEOUT_SECS: u64 = 15;
const NPM_SEARCH_PAGE_SIZE: usize = 250;
// 安全上限：防御异常 registry 无限翻页；@snsoft 实际包量远低于此。
const SEARCH_MAX_TOTAL: usize = 2000;
const SNSOFT_SCOPE: &str = "@snsoft";
const NEXUS_GROUP: &str = "snsoft";
const AUTH_HINT: &str = "请到 Settings → Package Registry 检查凭据";

// 客户端包白名单（产品线 family）：只保留这些产品线的 grpc / grpc-web 客户端
// 包，外加 @snsoft/js-sdk。后端服务包也叫 xxx-grpc，靠这个名单挡在结果之外；
// 更关键的是把 packument 补全的目标从「整个 registry（数百个）」压到 ~43 个，
// 让最新发布的包在首屏几秒内可见（否则要等全量 enrich，约 1 分钟）。
// 比对方式：去掉 @snsoft/ 前缀与 -grpc/-grpc-web 后缀得到 family，归一化
// （小写、仅保留字母数字）后与名单精确匹配，兼容 camelCase↔kebab-case
// （aiChat ↔ ai-chat、offlineCasino ↔ offline-casino）。
const ALLOWED_CLIENT_FAMILIES: &[&str] = &[
    "admin", "aichat", "auth", "biztreats", "ccms", "cms", "internal",
    "livechat", "offlinecasino", "packet", "payment", "player", "promotion",
    "proposal", "provider", "push", "recommend", "riskcontrol",
    "socialengagement", "telesales", "userengagement",
];

// 同一批 family 的「真实包名 casing」——用来直连拉 packument（最快路径）。
// registry 里的包名大小写就是这里的写法（如 @snsoft/riskControl-grpc-web）；
// 直连时还会额外试一遍全小写变体，兜住个别 casing 记不准的情况。
const CLIENT_FAMILY_NAMES: &[&str] = &[
    "admin", "aiChat", "auth", "biztreats", "ccms", "CMS", "internal",
    "livechat", "offlineCasino", "packet", "payment", "player", "promotion",
    "proposal", "provider", "push", "recommend", "riskControl",
    "socialEngagement", "telesales", "userEngagement",
];

// 由 family 名单推导出要直连的完整包名：每个 family × {-grpc, -grpc-web} ×
// {原样, 全小写}，外加 @snsoft/js-sdk。去重后并发拉 packument，404 的跳过。
fn client_package_candidates() -> Vec<String> {
    let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for fam in CLIENT_FAMILY_NAMES {
        for variant in [fam.to_string(), fam.to_lowercase()] {
            set.insert(format!("@snsoft/{variant}-grpc"));
            set.insert(format!("@snsoft/{variant}-grpc-web"));
        }
    }
    set.insert("@snsoft/js-sdk".to_string());
    set.into_iter().collect()
}

fn normalize_family_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_allowed_client_package(name: &str) -> bool {
    let Some(bare) = name.strip_prefix("@snsoft/") else {
        return false;
    };
    if bare == "js-sdk" {
        return true;
    }
    // 只认 grpc-web / grpc 客户端后缀（先试更长的 -grpc-web）；其它后缀或裸包
    // （多为后端）一律排除。
    let Some(stem) = bare
        .strip_suffix("-grpc-web")
        .or_else(|| bare.strip_suffix("-grpc"))
    else {
        return false;
    };
    ALLOWED_CLIENT_FAMILIES.contains(&normalize_family_key(stem).as_str())
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RegistryPackage {
    pub name: String,
    pub latest_version: String,
    // 全部版本（含发到任意 tag 的）里构建时间最新的那个——
    // 「最近发布」排序/显示用它；latest_version 只反映 latest tag。
    pub newest_version: String,
    pub description: Option<String>,
    // dist-tags（去掉 latest）——团队按项目打 tag 发布
    // （如 kyc-merge-account / freespin-every-day-v3），搜索要能按它命中。
    pub tags: Vec<String>,
    // 全版本列表（新到旧）。JS-SDK 没有 branch，前端按版本展开。
    pub versions: Vec<String>,
    // tag -> resolved version（含 latest），前端按 branch/tag 展开成多行并做安装状态匹配。
    pub dist_tags: HashMap<String, String>,
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

// js-sdk 系用 ISO 风格戳：2025-11-25T08-08-26-612Z → 20251125080826
fn iso_stamp(version: &str) -> Option<u64> {
    for (i, _) in version.match_indices('T') {
        if i < 10 {
            continue;
        }
        let date = &version[i - 10..i];
        let rest = &version[i + 1..];
        let db = date.as_bytes();
        let rb = rest.as_bytes();
        if db[4] == b'-' && db[7] == b'-' && rb.len() >= 8 && rb[2] == b'-' && rb[5] == b'-' {
            let parts = [
                &date[0..4],
                &date[5..7],
                &date[8..10],
                &rest[0..2],
                &rest[3..5],
                &rest[6..8],
            ];
            if parts.iter().all(|s| s.bytes().all(|b| b.is_ascii_digit())) {
                return parts.concat().parse().ok();
            }
        }
    }
    None
}

// snsoft 版本两种构建时间戳都认：14 位 YYYYMMDDHHMMSS（grpc 系）
// 与 ISO 风格 YYYY-MM-DDTHH-MM-SS-mmmZ（js-sdk 系）。比较新旧以它为准。
fn version_stamp(version: &str) -> Option<u64> {
    if let Some(s) = iso_stamp(version) {
        return Some(s);
    }
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

fn sort_dist_tags_by_version_desc(tags: &HashMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = tags
        .keys()
        .filter(|k| k.as_str() != "latest")
        .cloned()
        .collect();
    out.sort_by(|a, b| {
        let va = tags
            .get(a)
            .and_then(|version| version_stamp(version))
            .unwrap_or(0);
        let vb = tags
            .get(b)
            .and_then(|version| version_stamp(version))
            .unwrap_or(0);
        vb.cmp(&va).then_with(|| a.cmp(b))
    });
    out
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
                let version = obj.package.version;
                out.push(RegistryPackage {
                    name: obj.package.name,
                    newest_version: version.clone(),
                    latest_version: version.clone(),
                    description: obj.package.description,
                    tags: Vec::new(), // enrich_with_packuments 统一补
                    versions: vec![version],
                    dist_tags: HashMap::new(),
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

// 爬一个过滤条件下的全部分页（name_filter=None 即全量串行）。
// 每页把新出现的包名实时 emit 给前端先行展示。
async fn nexus_crawl(
    client: reqwest::Client,
    origin: String,
    repository: String,
    auth: String,
    name_filter: Option<String>,
    app: Option<tauri::AppHandle>,
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut versions_by_name: HashMap<String, Vec<String>> = HashMap::new();
    let mut token: Option<String> = None;
    let mut fetched = 0usize;
    loop {
        let mut url = format!(
            "{origin}/service/rest/v1/search?format=npm&repository={repository}&group={NEXUS_GROUP}"
        );
        if let Some(ref f) = name_filter {
            url.push_str("&name=");
            url.push_str(f);
        }
        if let Some(ref t) = token {
            url.push_str("&continuationToken=");
            url.push_str(t);
        }
        let resp = client
            .get(&url)
            .header("authorization", &auth)
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
        let mut page_new_names: Vec<String> = Vec::new();
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
                let entry = versions_by_name.entry(full_name.clone()).or_default();
                if entry.is_empty() {
                    page_new_names.push(full_name);
                }
                entry.push(v);
            }
        }
        if let (Some(ref app), false) = (app.as_ref(), page_new_names.is_empty()) {
            let _ = app.emit(DISCOVERED_EVENT, &page_new_names);
        }
        token = parsed.continuation_token;
        if token.is_none() || fetched >= SEARCH_MAX_TOTAL {
            break;
        }
    }
    Ok(versions_by_name)
}

// 分片前缀：Nexus 搜索的串行 continuationToken 是首拉慢的根源——按包名首字符
// 通配（a* b* … 9*）把翻页拆成 36 路并行，全量爬取从 10-30s 压到 1-3s。
const NEXUS_SHARD_ALPHABET: &str = "abcdefghijklmnopqrstuvwxyz0123456789";

async fn nexus_search_all(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<Vec<RegistryPackage>, String> {
    eprintln!("INFO nexus_search_all - entry");
    let origin = origin_of(registry_url).ok_or("无法从 registry URL 推导主机地址")?;
    let repository = repository_of(registry_url)
        .ok_or("registry URL 不含 /repository/ 段，无法推导 Nexus 仓库名")?;

    // 先分片并行；该实例若不支持 name 通配（全部分片为空）→ 回退全量串行。
    let mut merged: HashMap<String, Vec<String>> = HashMap::new();
    let mut set = tokio::task::JoinSet::new();
    for prefix in NEXUS_SHARD_ALPHABET.chars() {
        set.spawn(nexus_crawl(
            client.clone(),
            origin.clone(),
            repository.clone(),
            auth.to_string(),
            Some(format!("{prefix}*")),
            app.cloned(),
        ));
    }
    let mut shard_errors = 0usize;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(map)) => {
                for (name, mut versions) in map {
                    merged.entry(name).or_default().append(&mut versions);
                }
            }
            Ok(Err(err)) => {
                shard_errors += 1;
                eprintln!("WARN nexus_search_all - 分片失败: {err}");
            }
            Err(_) => shard_errors += 1,
        }
    }
    if merged.is_empty() {
        eprintln!("WARN nexus_search_all - 分片无结果（errors={shard_errors}），回退全量串行");
        merged = nexus_crawl(
            client.clone(),
            origin,
            repository,
            auth.to_string(),
            None,
            app.cloned(),
        )
        .await?;
    }

    let mut out: Vec<RegistryPackage> = merged
        .into_iter()
        .map(|(name, versions)| {
            let sorted = sort_versions_desc(versions);
            let newest = sorted.first().cloned().unwrap_or_default();
            RegistryPackage {
                name,
                newest_version: newest.clone(),
                latest_version: newest,
                description: None,
                tags: Vec::new(), // enrich_with_packuments 统一补
                versions: sorted,
                dist_tags: HashMap::new(),
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
pub(crate) async fn registry_search_packages(
    app: tauri::AppHandle,
) -> Result<Vec<RegistryPackage>, String> {
    use std::sync::atomic::Ordering;
    eprintln!("INFO registry_search_packages - entry");
    let (registry_url, auth_b64) = crate::registry::read_registry_connection()
        .ok_or_else(|| format!("registry 未配置 — {AUTH_HINT}"))?;
    let client = http_client()?;
    let auth = format!("Basic {auth_b64}");

    // 快路径：按已知客户端包名直连 packument——最快也最新（packument 不像搜索
    // 索引会滞后），并发拉取 + 逐批流式 ENRICHED，秒级出最新版本。
    let mut list = fetch_known_client_packages(&client, &registry_url, &auth, Some(&app)).await;

    // 兜底：直连一个都没拿到（endpoint 形态异常，或包名 casing 整体变化）→ 回退
    // 到原来的全量爬取 + 白名单过滤 + packument 补全。
    if list.is_empty() {
        eprintln!("WARN registry_search_packages - 直连 packument 无结果，回退全量爬取");
        let result = if NPM_SEARCH_UNSUPPORTED.load(Ordering::Relaxed) {
            nexus_search_all(&client, &registry_url, &auth, Some(&app)).await
        } else {
            // Nexus REST 能拿到全版本列表，是正常路径；npm search 只作为 Nexus
            // 不可用时的 fallback，避免正常刷新被慢 fallback 拖住。
            match nexus_search_all(&client, &registry_url, &auth, Some(&app)).await {
                Ok(l) if !l.is_empty() => Ok(l),
                other => {
                    match &other {
                        Ok(_) => eprintln!(
                            "WARN registry_search_packages - Nexus search 返回空，回退 npm search"
                        ),
                        Err(err) => {
                            eprintln!("WARN registry_search_packages - Nexus search 失败 ({err})，回退 npm search")
                        }
                    }
                    match npm_search_all(&client, &registry_url, &auth).await {
                        Ok(l) if !l.is_empty() => Ok(l),
                        Ok(_) => {
                            NPM_SEARCH_UNSUPPORTED.store(true, Ordering::Relaxed);
                            other
                        }
                        Err(err) => {
                            NPM_SEARCH_UNSUPPORTED.store(true, Ordering::Relaxed);
                            Err(err)
                        }
                    }
                }
            }
        };
        let mut crawled = result?;
        crawled.retain(|p| is_allowed_client_package(&p.name));
        enrich_recent_packuments(&client, &registry_url, &auth, &mut crawled, Some(&app)).await;
        list = crawled;
    }

    list.sort_by(|a, b| a.name.cmp(&b.name));
    eprintln!("INFO registry_search_packages - exit count={}", list.len());
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
        // 精简 packument（corgi）：只含 versions + dist-tags，无 README/全量元数据，
        // 体积小很多、传输解析都更快。Nexus 不支持时会退回完整文档，仍能反序列化。
        .header("accept", "application/vnd.npm.install-v1+json")
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

const PACKUMENT_CONCURRENCY: usize = 24;
// 直连已知包（~55 个候选，含小写兜底变体）：一轮全部并发打完，最少 round-trip。
const DIRECT_FETCH_CONCURRENCY: usize = 64;

fn recent_packument_indexes(list: &[RegistryPackage], limit: usize) -> Vec<usize> {
    let mut indexes: Vec<usize> = (0..list.len()).collect();
    indexes.sort_by(|a, b| {
        let pa = &list[*a];
        let pb = &list[*b];
        let va = version_stamp(&pa.newest_version).unwrap_or(0);
        let vb = version_stamp(&pb.newest_version).unwrap_or(0);
        vb.cmp(&va).then_with(|| pa.name.cmp(&pb.name))
    });
    indexes.truncate(limit.min(indexes.len()));
    indexes
}

fn apply_packument(pkg: &mut RegistryPackage, packument: Packument) {
    pkg.tags = sort_dist_tags_by_version_desc(&packument.dist_tags);
    pkg.dist_tags = packument.dist_tags;
    if let Some(latest) = pkg.dist_tags.get("latest") {
        pkg.latest_version = latest.clone();
    }
    // 「最近发布」= 全版本最大构建戳——发到任意 tag（不只 latest）都算。
    let versions = sort_versions_desc(packument.versions.into_keys().collect());
    if let Some(newest) = versions.first() {
        pkg.newest_version = newest.clone();
    }
    if !versions.is_empty() {
        pkg.versions = versions;
    }
    if pkg.description.is_none() {
        pkg.description = packument.description;
    }
    if pkg.latest_version.is_empty() {
        pkg.latest_version = pkg.newest_version.clone();
    }
}

// 快路径：不爬取整个 registry，直接按已知客户端包名并发拉 packument。packument
// 是最新数据（不像 Nexus 搜索索引会滞后），且只需 ~43 个包 → 秒级出结果。每批
// 完成即 emit ENRICHED，前端逐批渲染；404（该 family 无此协议/casing 不符）跳过。
async fn fetch_known_client_packages(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
    app: Option<&tauri::AppHandle>,
) -> Vec<RegistryPackage> {
    let names = client_package_candidates();
    let mut out: Vec<RegistryPackage> = Vec::new();
    for chunk in names.chunks(DIRECT_FETCH_CONCURRENCY) {
        let mut set = tokio::task::JoinSet::new();
        for name in chunk.iter().cloned() {
            let client = client.clone();
            let registry_url = registry_url.to_string();
            let auth = auth.to_string();
            set.spawn(async move {
                let result = fetch_packument(&client, &registry_url, &auth, &name).await;
                (name, result)
            });
        }
        let mut enriched: Vec<RegistryPackage> = Vec::new();
        while let Some(joined) = set.join_next().await {
            let Ok((name, Ok(packument))) = joined else { continue };
            let mut pkg = RegistryPackage {
                name,
                latest_version: String::new(),
                newest_version: String::new(),
                description: None,
                tags: Vec::new(),
                versions: Vec::new(),
                dist_tags: HashMap::new(),
            };
            apply_packument(&mut pkg, packument);
            // 无任何版本（空/已弃用包）→ 不展示
            if pkg.newest_version.is_empty() {
                continue;
            }
            out.push(pkg.clone());
            enriched.push(pkg);
        }
        if !enriched.is_empty() {
            if let Some(app) = app {
                let _ = app.emit(ENRICHED_EVENT, &enriched);
            }
        }
    }
    eprintln!(
        "INFO fetch_known_client_packages - resolved {} of {} candidates",
        out.len(),
        names.len()
    );
    out
}

// 列表补全：拉取【全部】包的 packument，把 dist-tags（项目标签，如
// kyc-merge-account）灌进搜索索引——分支搜索完全依赖它，必须全覆盖，否则
// 未 enrich 的包在分支搜索里不可见。按最近发布排序 + 并发分批 + 流式
// ENRICHED_EVENT：列表秒开不变，dist-tags 在后台几秒内逐批补全（可见的新
// 包最先到）。单包失败不影响整体——该包 tags 留空，仍可按名搜索。
async fn enrich_recent_packuments(
    client: &reqwest::Client,
    registry_url: &str,
    auth: &str,
    list: &mut [RegistryPackage],
    app: Option<&tauri::AppHandle>,
) {
    let indexes = recent_packument_indexes(list, list.len());
    for chunk in indexes.chunks(PACKUMENT_CONCURRENCY) {
        let mut set = tokio::task::JoinSet::new();
        for idx in chunk.iter().copied() {
            let client = client.clone();
            let registry_url = registry_url.to_string();
            let auth = auth.to_string();
            let name = list[idx].name.clone();
            set.spawn(async move {
                let result = fetch_packument(&client, &registry_url, &auth, &name).await;
                (idx, result)
            });
        }
        let mut enriched: Vec<RegistryPackage> = Vec::new();
        while let Some(joined) = set.join_next().await {
            let Ok((idx, result)) = joined else { continue };
            let Ok(packument) = result else { continue };
            apply_packument(&mut list[idx], packument);
            enriched.push(list[idx].clone());
        }
        if !enriched.is_empty() {
            if let Some(app) = app {
                let _ = app.emit(ENRICHED_EVENT, &enriched);
                // UI 不在时忽略；搜索结果本身仍会随 command 返回。
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
    fn version_stamp_parses_iso_style_js_sdk_builds() {
        assert_eq!(
            version_stamp("1.0.0-2025-11-25T08-08-26-612Z"),
            Some(20251125080826)
        );
        // ISO 2026 must sort above 14 位 2025
        let sorted = sort_versions_desc(vec![
            "1.0.0-2025-11-25T08-08-26-612Z".to_string(),
            "1.0.1-2026-01-05T10-00-00-000Z".to_string(),
        ]);
        assert_eq!(sorted[0], "1.0.1-2026-01-05T10-00-00-000Z");
    }

    #[test]
    fn version_stamp_extracts_14_digit_build_time() {
        assert_eq!(version_stamp("2.1.1-20260624172317"), Some(20260624172317));
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
    fn sort_dist_tags_prefers_newer_target_version() {
        let tags = HashMap::from([
            (
                "accumulative-bet-v3-1".to_string(),
                "3.2.0-20260601000000".to_string(),
            ),
            (
                "ai-disable-account".to_string(),
                "3.2.0-20260501000000".to_string(),
            ),
            (
                "kyc-optimization".to_string(),
                "3.2.0-20260707115119".to_string(),
            ),
            ("latest".to_string(), "3.2.0-20260101000000".to_string()),
        ]);

        assert_eq!(
            sort_dist_tags_by_version_desc(&tags),
            vec![
                "kyc-optimization",
                "accumulative-bet-v3-1",
                "ai-disable-account",
            ]
        );
    }

    #[test]
    fn recent_packument_indexes_prioritize_newest_builds() {
        let list = vec![
            RegistryPackage {
                name: "@snsoft/old-grpc".to_string(),
                latest_version: "1.0.0-20260101000000".to_string(),
                newest_version: "1.0.0-20260101000000".to_string(),
                description: None,
                tags: Vec::new(),
                versions: vec!["1.0.0-20260101000000".to_string()],
                dist_tags: HashMap::new(),
            },
            RegistryPackage {
                name: "@snsoft/newer-grpc".to_string(),
                latest_version: "1.0.0-20260707125835".to_string(),
                newest_version: "1.0.0-20260707125835".to_string(),
                description: None,
                tags: Vec::new(),
                versions: vec!["1.0.0-20260707125835".to_string()],
                dist_tags: HashMap::new(),
            },
            RegistryPackage {
                name: "@snsoft/middle-grpc".to_string(),
                latest_version: "1.0.0-20260707124025".to_string(),
                newest_version: "1.0.0-20260707124025".to_string(),
                description: None,
                tags: Vec::new(),
                versions: vec!["1.0.0-20260707124025".to_string()],
                dist_tags: HashMap::new(),
            },
        ];

        assert_eq!(recent_packument_indexes(&list, 2), vec![1, 2]);
    }

    #[test]
    fn registry_search_prefers_nexus_without_waiting_for_npm_fallback() {
        let source = include_str!("registry_search.rs");
        let start = source
            .find("pub(crate) async fn registry_search_packages")
            .expect("registry_search_packages exists");
        let end = source[start..]
            .find("async fn fetch_packument")
            .expect("fetch_packument follows registry_search_packages");
        let body = &source[start..start + end];

        assert!(
            !body.contains("tokio::join!("),
            "normal registry search should not wait for npm fallback when Nexus can return package versions"
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
