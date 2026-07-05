use crate::packages::ensure_packages_dir;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;

const REGISTRY_AUTH_SUFFIX: &str = ":_auth=";
const REGISTRY_PROTOCOLS: [&str; 3] = ["grpc-web", "grpc", "sdk"];
const REGISTRY_NPMRC_FILE: &str = ".npmrc";
const REGISTRY_NPMRC_TMP_FILE: &str = ".npmrc.tmp";
const REGISTRY_AUTH_SEPARATOR: &str = ":";
const REGISTRY_AUTH_QUOTE: char = '"';
const REGISTRY_ERROR_SEPARATOR: &str = "; ";
const REGISTRY_INVALID_CREDENTIAL_CHARACTERS: [char; 3] = [':', '\n', '\r'];
const REGISTRY_INVALID_URL_CHARACTERS: [char; 2] = ['\n', '\r'];
const REGISTRY_EMPTY_CREDENTIAL_MESSAGE: &str = "请输入用户名和密码";
const REGISTRY_INVALID_CREDENTIAL_MESSAGE: &str = "用户名/密码不能包含 `:` `\\n` `\\r`";
const REGISTRY_EMPTY_URL_MESSAGE: &str = "请输入 Registry URL";
const REGISTRY_INVALID_URL_MESSAGE: &str = "Registry URL 必须以 http:// 或 https:// 开头";
const REGISTRY_WRITE_SUCCESS_MESSAGE: &str =
    "已保存到 ~/.npmrc（并同步 grpc-web / grpc / sdk 三个目录）";
const REGISTRY_HTTP_PREFIX: &str = "http://";
const REGISTRY_HTTPS_PREFIX: &str = "https://";
const REGISTRY_URL_TRAILING_SLASH: char = '/';
const REGISTRY_SNSOFT_SCOPE_PREFIX: &str = "@snsoft:registry=";
const REGISTRY_SNSOFT_DEV_SCOPE_PREFIX: &str = "@snsoft-dev:registry=";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ConfiguredStatus {
    configured: bool,
    username: Option<String>,
    registry_url: Option<String>,
}

fn registry_unconfigured_status() -> ConfiguredStatus {
    eprintln!("INFO registry_unconfigured_status - entry");
    let status = ConfiguredStatus {
        configured: false,
        username: None,
        registry_url: None,
    };
    eprintln!("INFO registry_unconfigured_status - exit");
    status
}

fn registry_url_has_invalid_character(value: &str) -> bool {
    eprintln!("INFO registry_url_has_invalid_character - entry");
    let has_invalid_character = value
        .chars()
        .any(|character| REGISTRY_INVALID_URL_CHARACTERS.contains(&character));
    eprintln!(
        "INFO registry_url_has_invalid_character - exit invalid={}",
        has_invalid_character
    );
    has_invalid_character
}

fn normalize_registry_url(raw: &str) -> String {
    eprintln!("INFO normalize_registry_url - entry");
    let trimmed = raw.trim();
    let already_has_trailing_slash = trimmed.ends_with(REGISTRY_URL_TRAILING_SLASH);
    // 业务原因：npm scope registry 行约定以斜线结尾，缺斜线会导致 npm 拼接路径错。
    let normalized = if already_has_trailing_slash {
        trimmed.to_string()
    } else {
        format!("{trimmed}{REGISTRY_URL_TRAILING_SLASH}")
    };
    eprintln!("INFO normalize_registry_url - exit");
    normalized
}

fn derive_registry_auth_key(registry_url: &str) -> String {
    eprintln!("INFO derive_registry_auth_key - entry");
    let url_without_scheme = registry_url
        .strip_prefix(REGISTRY_HTTPS_PREFIX)
        .or_else(|| registry_url.strip_prefix(REGISTRY_HTTP_PREFIX))
        .unwrap_or(registry_url);
    let key = format!("//{url_without_scheme}{REGISTRY_AUTH_SUFFIX}");
    eprintln!("INFO derive_registry_auth_key - exit");
    key
}

fn derive_registry_scope_lines(registry_url: &str) -> [String; 2] {
    eprintln!("INFO derive_registry_scope_lines - entry");
    let scope_main = format!("{REGISTRY_SNSOFT_SCOPE_PREFIX}{registry_url}");
    let scope_dev = format!("{REGISTRY_SNSOFT_DEV_SCOPE_PREFIX}{registry_url}");
    eprintln!("INFO derive_registry_scope_lines - exit");
    [scope_main, scope_dev]
}

fn derive_registry_url_from_auth_line(line: &str) -> Option<String> {
    eprintln!("INFO derive_registry_url_from_auth_line - entry");
    let stripped_leading_slashes = line.strip_prefix("//")?;
    let auth_suffix_position = stripped_leading_slashes.find(REGISTRY_AUTH_SUFFIX)?;
    let url_without_scheme = &stripped_leading_slashes[..auth_suffix_position];
    let reconstructed = format!("{REGISTRY_HTTP_PREFIX}{url_without_scheme}");
    eprintln!("INFO derive_registry_url_from_auth_line - exit");
    Some(reconstructed)
}

fn registry_credential_has_invalid_character(value: &str) -> bool {
    eprintln!("INFO registry_credential_has_invalid_character - entry");
    let has_invalid_character = value
        .chars()
        .any(|character| REGISTRY_INVALID_CREDENTIAL_CHARACTERS.contains(&character));
    eprintln!(
        "INFO registry_credential_has_invalid_character - exit invalid={}",
        has_invalid_character
    );
    has_invalid_character
}

fn encode_registry_auth_value(username: &str, password: &str) -> String {
    eprintln!(
        "INFO encode_registry_auth_value - entry username={}",
        username
    );
    let credential = format!("{username}{REGISTRY_AUTH_SEPARATOR}{password}");
    let encoded = STANDARD.encode(credential);
    eprintln!("INFO encode_registry_auth_value - exit");
    encoded
}

fn read_optional_registry_npmrc(path: &Path) -> Result<String, String> {
    eprintln!(
        "INFO read_optional_registry_npmrc - entry path={}",
        path.display()
    );
    match fs::read_to_string(path) {
        Ok(content) => {
            eprintln!("INFO read_optional_registry_npmrc - exit found=true");
            Ok(content)
        }
        Err(error) => {
            let file_is_missing = error.kind() == std::io::ErrorKind::NotFound;
            // 业务原因：首次配置可能还没有 .npmrc，此时应从空文件内容开始生成。
            if file_is_missing {
                eprintln!(
                    "WARN read_optional_registry_npmrc - .npmrc 不存在，使用空内容 path={}",
                    path.display()
                );
                eprintln!("INFO read_optional_registry_npmrc - exit found=false");
                return Ok(String::new());
            }
            eprintln!(
                "ERROR read_optional_registry_npmrc - 读取 .npmrc 失败 path={} error={}",
                path.display(),
                error
            );
            Err(error.to_string())
        }
    }
}

// 业务原因：registry 配置必须写进「全局」~/.npmrc 而不是 ~/.penguin/<protocol>/.npmrc。
// 每次安装前 mirror_npmrc 都会用 ~/.npmrc 覆盖（或删除）各协议目录的本地 .npmrc；
// 配置只写本地的话，下一次安装就会被抹掉，npm 回落到公网 registry 导致 E404。
fn write_registry_npmrc_into(
    npmrc_path: &Path,
    auth_key: &str,
    auth_line: &str,
    scope_lines: &[String; 2],
) -> Result<(), String> {
    eprintln!(
        "INFO write_registry_npmrc_into - entry path={}",
        npmrc_path.display()
    );
    let dir_path = npmrc_path
        .parent()
        .ok_or_else(|| format!("npmrc 路径没有父目录: {}", npmrc_path.display()))?;
    let tmp_path = dir_path.join(REGISTRY_NPMRC_TMP_FILE);
    let content = read_optional_registry_npmrc(npmrc_path)?;
    let mut auth_replaced = false;
    let mut lines: Vec<String> = Vec::new();

    // 业务原因：换 Registry URL 后，旧 Nexus 主机的 _auth 行不能留在 ~/.npmrc 里
    // （这是用户全局文件，遗留凭证会一直随请求发给旧主机）。只删「旧 @snsoft scope
    // 行指向的主机」的 auth 行，用户其他工具（如 GitHub Packages）的 auth 行不动。
    let stale_auth_keys: Vec<String> = content
        .lines()
        .filter_map(|line| {
            let stale_main = line
                .strip_prefix(REGISTRY_SNSOFT_SCOPE_PREFIX)
                .filter(|_| line != scope_lines[0]);
            let stale_dev = line
                .strip_prefix(REGISTRY_SNSOFT_DEV_SCOPE_PREFIX)
                .filter(|_| line != scope_lines[1]);
            stale_main.or(stale_dev)
        })
        .map(derive_registry_auth_key)
        .collect();

    for line in content.lines() {
        let is_auth_line = line.starts_with(auth_key);
        let is_stale_snsoft_scope_line =
            line.starts_with(REGISTRY_SNSOFT_SCOPE_PREFIX) && line != scope_lines[0];
        let is_stale_snsoft_dev_scope_line =
            line.starts_with(REGISTRY_SNSOFT_DEV_SCOPE_PREFIX) && line != scope_lines[1];
        let is_stale_scope_line = is_stale_snsoft_scope_line || is_stale_snsoft_dev_scope_line;
        let is_stale_auth_line =
            !is_auth_line && stale_auth_keys.iter().any(|key| line.starts_with(key.as_str()));
        // 业务原因：Sonatype token 轮换后必须覆盖旧 _auth 行，避免 npm 继续用失效凭证。
        if is_auth_line {
            eprintln!("WARN write_registry_npmrc_into - 替换旧 registry auth");
            lines.push(auth_line.to_string());
            auth_replaced = true;
            continue;
        }
        // 业务原因：用户改了 Registry URL 后，旧的 @snsoft scope 行还指向旧 URL，会导致 npm 路由错误，必须丢弃。
        if is_stale_scope_line {
            eprintln!("WARN write_registry_npmrc_into - 丢弃旧 scope 行");
            continue;
        }
        // 业务原因：旧 Nexus 的 _auth 行随 scope 一起丢弃，避免失效凭证残留在用户全局 .npmrc。
        if is_stale_auth_line {
            eprintln!("WARN write_registry_npmrc_into - 丢弃旧 registry auth 行");
            continue;
        }
        lines.push(line.to_string());
    }

    let auth_line_is_missing = !auth_replaced;
    // 业务原因：缺少 registry auth 行时必须补上，否则安装内部包仍会 401。
    if auth_line_is_missing {
        eprintln!("WARN write_registry_npmrc_into - 追加 registry auth");
        lines.push(auth_line.to_string());
    }

    for scope_line in scope_lines.iter().rev() {
        let scope_line_exists = lines.iter().any(|line| line == scope_line);
        let scope_line_is_missing = !scope_line_exists;
        // 业务原因：内部包作用域必须显式指向 Nexus，避免 npm 走默认公网 registry。
        if scope_line_is_missing {
            eprintln!("WARN write_registry_npmrc_into - 补齐 scope registry");
            lines.insert(0, scope_line.to_string());
        }
    }

    let output = format!("{}\n", lines.join("\n"));
    fs::write(&tmp_path, output).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, npmrc_path).map_err(|error| error.to_string())?;
    eprintln!(
        "INFO write_registry_npmrc_into - exit path={}",
        npmrc_path.display()
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn write_registry_npmrc(
    registry_url: String,
    username: String,
    password: String,
) -> Result<String, String> {
    eprintln!("INFO write_registry_npmrc - entry username={}", username);

    let registry_url_trimmed = registry_url.trim();
    let registry_url_is_empty = registry_url_trimmed.is_empty();
    // 业务原因：空 URL 无法构造 npm _auth key 与 scope 行。
    if registry_url_is_empty {
        eprintln!("WARN write_registry_npmrc - registry url 为空");
        return Err(REGISTRY_EMPTY_URL_MESSAGE.to_string());
    }

    let url_starts_with_http = registry_url_trimmed.starts_with(REGISTRY_HTTP_PREFIX);
    let url_starts_with_https = registry_url_trimmed.starts_with(REGISTRY_HTTPS_PREFIX);
    let url_scheme_is_valid = url_starts_with_http || url_starts_with_https;
    // 业务原因：限定 http/https 防止 shell 注入（npm 也只识别这两种）。
    if !url_scheme_is_valid {
        eprintln!("WARN write_registry_npmrc - registry url scheme 非法");
        return Err(REGISTRY_INVALID_URL_MESSAGE.to_string());
    }

    let url_has_invalid_character = registry_url_has_invalid_character(registry_url_trimmed);
    // 业务原因：URL 含换行会破坏 .npmrc 行结构。
    if url_has_invalid_character {
        eprintln!("WARN write_registry_npmrc - registry url 含非法字符");
        return Err(REGISTRY_INVALID_URL_MESSAGE.to_string());
    }

    let username_is_empty = username.is_empty();
    // 业务原因：空用户名无法生成有效 Nexus 凭证，必须在写盘前拒绝。
    if username_is_empty {
        eprintln!("WARN write_registry_npmrc - 用户名为空");
        return Err(REGISTRY_EMPTY_CREDENTIAL_MESSAGE.to_string());
    }

    let password_is_empty = password.is_empty();
    // 业务原因：空密码无法生成有效 Nexus 凭证，必须在写盘前拒绝。
    if password_is_empty {
        eprintln!("WARN write_registry_npmrc - 密码为空");
        return Err(REGISTRY_EMPTY_CREDENTIAL_MESSAGE.to_string());
    }

    let username_has_invalid_character = registry_credential_has_invalid_character(&username);
    // 业务原因：用户名进入 username:password 拼接格式，非法字符会破坏 npm _auth。
    if username_has_invalid_character {
        eprintln!("WARN write_registry_npmrc - 用户名包含非法字符");
        return Err(REGISTRY_INVALID_CREDENTIAL_MESSAGE.to_string());
    }

    let password_has_invalid_character = registry_credential_has_invalid_character(&password);
    // 业务原因：密码进入 username:password 拼接格式，非法字符会破坏 npm _auth。
    if password_has_invalid_character {
        eprintln!("WARN write_registry_npmrc - 密码包含非法字符");
        return Err(REGISTRY_INVALID_CREDENTIAL_MESSAGE.to_string());
    }

    let normalized_url = normalize_registry_url(registry_url_trimmed);
    let auth_key = derive_registry_auth_key(&normalized_url);
    let scope_lines = derive_registry_scope_lines(&normalized_url);
    let auth_value = encode_registry_auth_value(&username, &password);
    let auth_line = format!("{auth_key}{auth_value}");

    // 业务原因：~/.npmrc 是唯一事实来源——mirror_npmrc 在每次安装前都会用它
    // 覆盖各协议目录的 .npmrc，配置只有写在这里才能存活到下一次安装。
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let global_npmrc = home.join(REGISTRY_NPMRC_FILE);
    write_registry_npmrc_into(&global_npmrc, &auth_key, &auth_line, &scope_lines)?;

    let mut errors: Vec<String> = Vec::new();
    for protocol in REGISTRY_PROTOCOLS {
        // ensure_packages_dir 会把刚写好的 ~/.npmrc 镜像进协议目录，让配置立即生效。
        match ensure_packages_dir(protocol.to_string()) {
            Ok(_dir) => {
                eprintln!("INFO write_registry_npmrc - protocol synced {}", protocol);
            }
            Err(error) => {
                eprintln!(
                    "ERROR write_registry_npmrc - protocol sync failed {} error={}",
                    protocol, error
                );
                errors.push(format!("{protocol}: {error}"));
            }
        }
    }

    let has_errors = !errors.is_empty();
    // 业务原因：任一协议目录同步失败都会导致安装链路仍可能 401，必须把失败明细返回给 UI。
    if has_errors {
        let joined_errors = errors.join(REGISTRY_ERROR_SEPARATOR);
        eprintln!(
            "WARN write_registry_npmrc - partial failure {}",
            joined_errors
        );
        return Err(joined_errors);
    }

    eprintln!("INFO write_registry_npmrc - exit success");
    Ok(REGISTRY_WRITE_SUCCESS_MESSAGE.to_string())
}

fn read_registry_npmrc_status_inner() -> ConfiguredStatus {
    eprintln!("INFO read_registry_npmrc_status_inner - entry");
    // 业务原因：配置的事实来源是 ~/.npmrc（协议目录里的只是镜像副本），状态必须从源头读。
    let home = match dirs::home_dir() {
        Some(home) => home,
        None => {
            eprintln!("WARN read_registry_npmrc_status_inner - 无法定位用户主目录");
            return registry_unconfigured_status();
        }
    };
    let npmrc_path = home.join(REGISTRY_NPMRC_FILE);
    let content = match fs::read_to_string(&npmrc_path) {
        Ok(content) => content,
        Err(error) => {
            eprintln!(
                "WARN read_registry_npmrc_status_inner - 无法读取 .npmrc path={} error={}",
                npmrc_path.display(),
                error
            );
            return registry_unconfigured_status();
        }
    };
    let auth_line = match content
        .lines()
        .find(|line| line.starts_with("//") && line.contains(REGISTRY_AUTH_SUFFIX))
    {
        Some(line) => line,
        None => {
            eprintln!("WARN read_registry_npmrc_status_inner - 未找到 registry auth 行");
            return registry_unconfigured_status();
        }
    };
    let recovered_registry_url = match derive_registry_url_from_auth_line(auth_line) {
        Some(url) => url,
        None => {
            eprintln!("WARN read_registry_npmrc_status_inner - 无法从 auth 行还原 registry url");
            return registry_unconfigured_status();
        }
    };
    let auth_suffix_position = match auth_line.find(REGISTRY_AUTH_SUFFIX) {
        Some(position) => position,
        None => {
            eprintln!("WARN read_registry_npmrc_status_inner - auth 行缺少 _auth= 分隔符");
            return registry_unconfigured_status();
        }
    };
    let encoded_auth = auth_line[auth_suffix_position + REGISTRY_AUTH_SUFFIX.len()..]
        .trim()
        .trim_matches(REGISTRY_AUTH_QUOTE);
    let decoded_bytes = match STANDARD.decode(encoded_auth) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!(
                "WARN read_registry_npmrc_status_inner - registry auth base64 解码失败 error={}",
                error
            );
            return registry_unconfigured_status();
        }
    };
    let decoded_text = match String::from_utf8(decoded_bytes) {
        Ok(text) => text,
        Err(error) => {
            eprintln!(
                "WARN read_registry_npmrc_status_inner - registry auth 不是有效 UTF-8 error={}",
                error
            );
            return registry_unconfigured_status();
        }
    };
    let username = match decoded_text.split_once(REGISTRY_AUTH_SEPARATOR) {
        Some((username, _password)) => username,
        None => {
            eprintln!("WARN read_registry_npmrc_status_inner - registry auth 缺少分隔符");
            return registry_unconfigured_status();
        }
    };
    let username_is_empty = username.is_empty();
    // 业务原因：空用户名不能代表已配置凭证，必须按未配置展示。
    if username_is_empty {
        eprintln!("WARN read_registry_npmrc_status_inner - registry auth 用户名为空");
        return registry_unconfigured_status();
    }

    let status = ConfiguredStatus {
        configured: true,
        username: Some(username.to_string()),
        registry_url: Some(recovered_registry_url),
    };
    eprintln!("INFO read_registry_npmrc_status_inner - exit configured=true");
    status
}

#[tauri::command]
pub(crate) fn read_registry_npmrc_status() -> Result<ConfiguredStatus, String> {
    eprintln!("INFO read_registry_npmrc_status - entry");
    let status = read_registry_npmrc_status_inner();
    eprintln!(
        "INFO read_registry_npmrc_status - exit configured={}",
        status.configured
    );
    Ok(status)
}

#[cfg(test)]
mod registry_auth_tests {
    use super::*;

    const TEST_USERNAME: &str = "alice";
    const TEST_PASSWORD: &str = "secret";
    const TEST_CREDENTIAL: &str = "alice:secret";

    #[test]
    fn encode_registry_auth_value_uses_username_colon_password() -> Result<(), String> {
        let encoded = encode_registry_auth_value(TEST_USERNAME, TEST_PASSWORD);
        let decoded_bytes = STANDARD
            .decode(encoded)
            .map_err(|error| error.to_string())?;
        let decoded_text = String::from_utf8(decoded_bytes).map_err(|error| error.to_string())?;
        assert_eq!(decoded_text, TEST_CREDENTIAL);
        Ok(())
    }

    #[test]
    fn derive_registry_auth_key_strips_http_scheme() {
        let key = derive_registry_auth_key("http://sonatype.client88.me/repository/npm_hosted/");
        assert_eq!(key, "//sonatype.client88.me/repository/npm_hosted/:_auth=");
    }

    #[test]
    fn derive_registry_auth_key_strips_https_scheme() {
        let key = derive_registry_auth_key("https://nexus.example.com/repo/");
        assert_eq!(key, "//nexus.example.com/repo/:_auth=");
    }

    #[test]
    fn derive_registry_scope_lines_uses_both_scopes() {
        let lines =
            derive_registry_scope_lines("http://sonatype.client88.me/repository/npm_hosted/");
        assert_eq!(
            lines[0],
            "@snsoft:registry=http://sonatype.client88.me/repository/npm_hosted/"
        );
        assert_eq!(
            lines[1],
            "@snsoft-dev:registry=http://sonatype.client88.me/repository/npm_hosted/"
        );
    }

    #[test]
    fn derive_registry_url_from_auth_line_roundtrips() {
        let line = "//sonatype.client88.me/repository/npm_hosted/:_auth=YWRtaW46c25zb2Z0MTIz";
        let url = derive_registry_url_from_auth_line(line).expect("expected url");
        assert_eq!(url, "http://sonatype.client88.me/repository/npm_hosted/");
    }

    #[test]
    fn derive_registry_url_from_auth_line_rejects_non_auth_line() {
        let line = "@snsoft:registry=http://sonatype.client88.me/repository/npm_hosted/";
        let url = derive_registry_url_from_auth_line(line);
        assert!(url.is_none());
    }

    // Regression test for the adrianchong E404: registry settings used to be
    // written ONLY into ~/.penguin/<protocol>/.npmrc, which mirror_npmrc
    // clobbers (or deletes) from ~/.npmrc on every install. The fix writes
    // settings into the GLOBAL npmrc so the mirror propagates them instead
    // of wiping them.
    #[test]
    fn write_into_global_then_mirror_preserves_registry_config() {
        let dir = registry_scratch_dir("survive-mirror");
        let global = dir.join("home.npmrc");
        let local = dir.join("local.npmrc");
        let url = "http://nexus.example.com/repo/";
        let auth_key = derive_registry_auth_key(url);
        let auth_line = format!(
            "{auth_key}{}",
            encode_registry_auth_value(TEST_USERNAME, TEST_PASSWORD)
        );
        let scope_lines = derive_registry_scope_lines(url);

        write_registry_npmrc_into(&global, &auth_key, &auth_line, &scope_lines)
            .expect("write into global npmrc");
        crate::packages::mirror_npmrc(&global, &local);

        let local_content = fs::read_to_string(&local).expect("local npmrc after mirror");
        assert!(
            local_content.contains("@snsoft:registry=http://nexus.example.com/repo/"),
            "scope line lost after mirror: {local_content:?}"
        );
        assert!(
            local_content.contains(&auth_line),
            "auth line lost after mirror: {local_content:?}"
        );
    }

    #[test]
    fn write_into_creates_file_when_missing() {
        let dir = registry_scratch_dir("create");
        let npmrc = dir.join("home.npmrc");
        let url = "http://nexus.example.com/repo/";
        let auth_key = derive_registry_auth_key(url);
        let auth_line = format!(
            "{auth_key}{}",
            encode_registry_auth_value(TEST_USERNAME, TEST_PASSWORD)
        );
        let scope_lines = derive_registry_scope_lines(url);

        write_registry_npmrc_into(&npmrc, &auth_key, &auth_line, &scope_lines)
            .expect("write into fresh npmrc");

        let content = fs::read_to_string(&npmrc).expect("npmrc created");
        assert!(content.contains(&scope_lines[0]), "missing scope: {content:?}");
        assert!(content.contains(&scope_lines[1]), "missing dev scope: {content:?}");
        assert!(content.contains(&auth_line), "missing auth: {content:?}");
    }

    #[test]
    fn write_into_replaces_stale_lines_and_keeps_unrelated_ones() {
        let dir = registry_scratch_dir("merge");
        let npmrc = dir.join("home.npmrc");
        fs::write(
            &npmrc,
            "registry=https://registry.npmjs.org/\n\
             @snsoft:registry=http://old.example.com/repo/\n\
             @snsoft-dev:registry=http://old.example.com/repo/\n\
             //old.example.com/repo/:_auth=b2xkOm9sZA==\n",
        )
        .unwrap();
        let url = "http://new.example.com/repo/";
        let auth_key = derive_registry_auth_key(url);
        let auth_line = format!(
            "{auth_key}{}",
            encode_registry_auth_value(TEST_USERNAME, TEST_PASSWORD)
        );
        let scope_lines = derive_registry_scope_lines(url);

        write_registry_npmrc_into(&npmrc, &auth_key, &auth_line, &scope_lines)
            .expect("merge into existing npmrc");

        let content = fs::read_to_string(&npmrc).unwrap();
        assert!(
            content.contains("registry=https://registry.npmjs.org/"),
            "unrelated line dropped: {content:?}"
        );
        assert!(
            !content.contains("old.example.com"),
            "stale scope line survived: {content:?}"
        );
        assert!(content.contains(&scope_lines[0]), "missing scope: {content:?}");
        assert!(content.contains(&auth_line), "missing auth: {content:?}");
    }

    fn registry_scratch_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("penguin-registry-{label}-{pid}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn normalize_registry_url_appends_trailing_slash() {
        let normalized = normalize_registry_url("http://nexus.example.com/repo");
        assert_eq!(normalized, "http://nexus.example.com/repo/");
    }

    #[test]
    fn normalize_registry_url_preserves_trailing_slash() {
        let normalized = normalize_registry_url("http://nexus.example.com/repo/");
        assert_eq!(normalized, "http://nexus.example.com/repo/");
    }
}
