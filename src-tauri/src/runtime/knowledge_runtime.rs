//! Versioned, fail-closed storage for the CLI/MCP knowledge runtime.
//!
//! A generation is copied into a private staging directory, verified through
//! the real CLI and MCP entry points, and only then published. Once published
//! a generation is never modified in place; `current` is the only mutable
//! activation pointer.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const RUNTIME_MANIFEST_SCHEMA: u32 = 1;
pub const DEFAULT_CONTRACT_SCHEMA_VERSION: u32 = 18;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
static ACTIVATION_LOCK: Mutex<()> = Mutex::new(());
static NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeNativeDependency {
    pub name: String,
    pub version: String,
    pub path: String,
    pub sha256: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSigning {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notarized: Option<bool>,
}

impl Default for RuntimeSigning {
    fn default() -> Self {
        Self { status: "unknown".to_string(), identity: None, notarized: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub build_id: String,
    pub app_version: String,
    pub capability_hash: String,
    pub model_hash: String,
    pub schema_version: u32,
    #[serde(default = "default_contract_schema_version")]
    pub contract_schema_version: u32,
    #[serde(default = "default_contract_version")]
    pub contract_version: String,
    pub cli_entry: String,
    pub mcp_entry: String,
    pub node_path: String,
    pub wasm_path: String,
    pub created_at: String,
    pub file_hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub architecture: String,
    #[serde(default)]
    pub native_dependencies: Vec<RuntimeNativeDependency>,
    #[serde(default)]
    pub signing: RuntimeSigning,
    pub ready: bool,
}

fn default_contract_schema_version() -> u32 { DEFAULT_CONTRACT_SCHEMA_VERSION }
fn default_contract_version() -> String { "2".to_string() }

#[derive(Debug, Clone)]
pub struct KnowledgeRuntimeManager { root: PathBuf }

impl KnowledgeRuntimeManager {
    pub fn new(root: impl Into<PathBuf>) -> Self { Self { root: root.into() } }
    pub fn root(&self) -> &Path { &self.root }

    /// Copy a complete runtime tree, verify its executable contracts, and
    /// atomically make it current.
    pub fn install_bundled_knowledge_runtime(&self, source: &Path, manifest: RuntimeManifest) -> Result<RuntimeManifest, String> {
        self.install_from_staging(manifest, |staging| copy_tree(source, staging))
    }

    /// Tauri resources keep the CLI and MCP bundles in separate directories.
    /// Materialize them into one generation so every surface uses the same
    /// Node, WASM, capability hash, and contract.
    pub fn install_bundled_knowledge_runtime_from_bundles(
        &self,
        cli_source: &Path,
        mcp_source: &Path,
        manifest: RuntimeManifest,
    ) -> Result<RuntimeManifest, String> {
        self.install_from_staging(manifest, |staging| {
            copy_tree(cli_source, staging)?;
            copy_tree_without_runtime(mcp_source, &staging.join("mcp"))
        })
    }

    fn install_from_staging<F>(&self, mut manifest: RuntimeManifest, copy: F) -> Result<RuntimeManifest, String>
    where F: FnOnce(&Path) -> Result<(), String> {
        let _guard = ACTIVATION_LOCK.lock().map_err(|_| "runtime activation lock poisoned".to_string())?;
        validate_manifest_shape(&manifest)?;
        validate_build_id(&manifest.build_id)?;
        fs::create_dir_all(&self.root).map_err(|e| format!("create runtime root: {e}"))?;
        let generation = self.root.join(&manifest.build_id);
        if generation.exists() {
            let existing = self.verify_knowledge_runtime(&generation)?;
            if existing != manifest && !manifest.file_hashes.is_empty() {
                return Err("RUNTIME_BUILD_EXISTS: immutable generation has different manifest".to_string());
            }
            return self.activate_locked(existing);
        }

        let staging = self.root.join(format!(".staging-{}", nonce()));
        let result = (|| {
            copy(&staging)?;
            validate_runtime_files(&staging, &manifest)?;
            let actual_hashes = hash_tree(&staging)?;
            if !manifest.file_hashes.is_empty() && manifest.file_hashes != actual_hashes {
                return Err("RUNTIME_HASH_MISMATCH: staged file hashes do not match manifest".to_string());
            }
            manifest.file_hashes = actual_hashes;
            verify_runtime_contract(&staging, &manifest)?;
            manifest.ready = true;
            write_json(&staging.join("manifest.json"), &manifest)?;
            write_atomic_text(&staging.join(".ready"), &manifest.build_id)?;
            fs::rename(&staging, &generation).map_err(|e| format!("publish runtime generation: {e}"))?;
            self.activate_locked(manifest.clone())
        })();
        if result.is_err() { let _ = fs::remove_dir_all(&staging); }
        result
    }

    pub fn active_knowledge_runtime(&self) -> Result<RuntimeManifest, String> {
        let current = self.current_dir()?;
        self.verify_knowledge_runtime(&current)
    }

    /// Return the canonical resolved generation directory. Callers must join
    /// manifest-relative entries to this path, never to the store root; the
    /// latter bypasses the `current` activation pointer.
    pub fn active_knowledge_runtime_dir(&self) -> Result<PathBuf, String> {
        self.current_dir()
    }

    /// Verify manifest shape, required files, hashes, and the CLI/MCP runtime
    /// contract at `path`. This is usable before activation.
    pub fn verify_knowledge_runtime(&self, path: &Path) -> Result<RuntimeManifest, String> {
        let manifest_path = path.join("manifest.json");
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("RUNTIME_MANIFEST_INVALID: read {}: {e}", manifest_path.display()))?;
        let manifest: RuntimeManifest = serde_json::from_str(&raw)
            .map_err(|e| format!("RUNTIME_MANIFEST_INVALID: parse {}: {e}", manifest_path.display()))?;
        validate_manifest_shape(&manifest)?;
        validate_build_id(&manifest.build_id)?;
        if path.file_name().and_then(|n| n.to_str()) != Some(manifest.build_id.as_str()) {
            return Err("RUNTIME_MANIFEST_INVALID: manifest buildId does not match generation directory".to_string());
        }
        let ready = fs::read_to_string(path.join(".ready"))
            .map_err(|e| format!("RUNTIME_NOT_READY: read ready marker: {e}"))?;
        if ready.trim() != manifest.build_id {
            return Err("RUNTIME_NOT_READY: ready marker does not match buildId".to_string());
        }
        validate_runtime_files(path, &manifest)?;
        if hash_tree(path)? != manifest.file_hashes {
            return Err("RUNTIME_HASH_MISMATCH: active runtime files differ from manifest".to_string());
        }
        verify_runtime_contract(path, &manifest)?;
        Ok(manifest)
    }

    pub fn switch_knowledge_runtime(&self, build_id: &str) -> Result<RuntimeManifest, String> {
        let _guard = ACTIVATION_LOCK.lock().map_err(|_| "runtime activation lock poisoned".to_string())?;
        validate_build_id(build_id)?;
        let manifest = self.verify_knowledge_runtime(&self.root.join(build_id))?;
        self.activate_locked(manifest)
    }

    pub fn rollback_knowledge_runtime(&self, build_id: &str) -> Result<RuntimeManifest, String> {
        self.switch_knowledge_runtime(build_id)
    }

    fn activate_locked(&self, manifest: RuntimeManifest) -> Result<RuntimeManifest, String> {
        let current = self.current_dir().ok();
        if current.as_ref().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some(manifest.build_id.as_str()) {
            return Ok(manifest);
        }
        let generation = self.root.join(&manifest.build_id);
        let pointer = self.root.join("current");
        #[cfg(unix)]
        {
            let tmp = self.root.join(format!(".current-{}", nonce()));
            std::os::unix::fs::symlink(&generation, &tmp).map_err(|e| format!("create runtime pointer: {e}"))?;
            // Do not remove `current` first: rename replaces the old symlink
            // on Unix and therefore leaves no observable no-current window.
            if let Err(error) = fs::rename(&tmp, &pointer) {
                let _ = fs::remove_file(&tmp);
                return Err(format!("activate runtime pointer: {error}"));
            }
        }
        #[cfg(not(unix))]
        write_atomic_text(&pointer, &manifest.build_id)?;
        write_json(&self.root.join("manifest.json"), &manifest)?;
        Ok(manifest)
    }

    fn current_dir(&self) -> Result<PathBuf, String> {
        let current = self.root.join("current");
        if !current.exists() { return Err("RUNTIME_NOT_INSTALLED: current runtime pointer is missing".to_string()); }
        let dir = fs::canonicalize(&current).map_err(|e| format!("RUNTIME_NOT_INSTALLED: resolve current: {e}"))?;
        let root = fs::canonicalize(&self.root).map_err(|e| format!("RUNTIME_NOT_INSTALLED: resolve runtime root: {e}"))?;
        if dir.parent() != Some(root.as_path()) { return Err("RUNTIME_MANIFEST_INVALID: current pointer escapes runtime root".to_string()); }
        Ok(dir)
    }
}

pub fn runtime_root() -> Option<PathBuf> { dirs::home_dir().map(|home| home.join(".penguin").join("runtimes")) }

fn validate_manifest_shape(manifest: &RuntimeManifest) -> Result<(), String> {
    if manifest.schema_version != RUNTIME_MANIFEST_SCHEMA { return Err(format!("RUNTIME_MANIFEST_INVALID: unsupported manifest schema {}", manifest.schema_version)); }
    if manifest.build_id.is_empty() || manifest.app_version.is_empty() || manifest.capability_hash.len() != 64 || !manifest.capability_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) || manifest.model_hash.len() != 64 || !manifest.model_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) || manifest.contract_schema_version == 0 || manifest.contract_version.is_empty() || manifest.cli_entry.is_empty() || manifest.mcp_entry.is_empty() || manifest.node_path.is_empty() || manifest.wasm_path.is_empty() || manifest.created_at.is_empty() || manifest.platform.is_empty() || manifest.architecture.is_empty() {
        return Err("RUNTIME_MANIFEST_INVALID: incomplete manifest".to_string());
    }
    if !matches!(manifest.signing.status.as_str(), "signed" | "unsigned" | "unknown") {
        return Err("RUNTIME_MANIFEST_INVALID: signing status must be signed, unsigned, or unknown".to_string());
    }
    Ok(())
}

fn validate_build_id(build_id: &str) -> Result<(), String> {
    if build_id.is_empty() || build_id == "." || build_id == ".." || !build_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) {
        return Err("RUNTIME_MANIFEST_INVALID: buildId must be a safe directory name".to_string());
    }
    Ok(())
}

fn validate_runtime_files(root: &Path, manifest: &RuntimeManifest) -> Result<(), String> {
    for (value, field) in [(&manifest.cli_entry, "cliEntry"), (&manifest.mcp_entry, "mcpEntry"), (&manifest.node_path, "nodePath"), (&manifest.wasm_path, "wasmPath")] { validate_relative_runtime_path(root, value, field)?; }
    let cli = root.join(&manifest.cli_entry); let mcp = root.join(&manifest.mcp_entry); let node = root.join(&manifest.node_path); let wasm = root.join(&manifest.wasm_path); let modules = root.join("node_modules");
    for (path, label) in [(&cli, "CLI entry"), (&mcp, "MCP entry"), (&node, "bundled Node")] { if !path.is_file() { return Err(format!("RUNTIME_NOT_INSTALLED: missing {label} {}", path.display())); } }
    if !wasm.is_dir() || !contains_file_with_extension(&wasm, "wasm") { return Err(format!("RUNTIME_NOT_INSTALLED: missing WASM payload {}", wasm.display())); }
    if !modules.is_dir() || !contains_file_with_extension(&modules, "node") { return Err(format!("RUNTIME_NOT_INSTALLED: missing native module under {}", modules.display())); }
    for dependency in &manifest.native_dependencies {
        validate_relative_runtime_path(root, &dependency.path, "native dependency path")?;
        let path = root.join(&dependency.path);
        if !path.is_file() {
            return Err(format!("RUNTIME_NOT_INSTALLED: missing native dependency {}", path.display()));
        }
        if dependency.sha256.is_empty() || sha256_file(&path) != dependency.sha256 {
            return Err(format!("RUNTIME_HASH_MISMATCH: native dependency {} does not match manifest", path.display()));
        }
        if dependency.status != "ready" {
            return Err(format!("RUNTIME_NATIVE_UNAVAILABLE: native dependency {} is {}", dependency.name, dependency.status));
        }
    }
    if let Some(model_manifest) = manifest.native_dependencies.iter().find(|dependency| dependency.name == "embedding-model-manifest") {
        if model_manifest.sha256 != manifest.model_hash {
            return Err("RUNTIME_CONTRACT_MISMATCH: modelHash differs from the bundled model manifest".to_string());
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .unwrap_or_default()
}

fn contains_file_with_extension(root: &Path, extension: &str) -> bool {
    fs::read_dir(root).ok().into_iter().flatten().flatten().any(|entry| { let path = entry.path(); if path.is_dir() { contains_file_with_extension(&path, extension) } else { path.extension().and_then(|ext| ext.to_str()) == Some(extension) } })
}

fn validate_relative_runtime_path(root: &Path, value: &str, field: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.is_absolute() || path.components().any(|component| component == std::path::Component::ParentDir) { return Err(format!("RUNTIME_MANIFEST_INVALID: {field} must stay inside the active runtime")); }
    if !root.join(path).starts_with(root) { return Err(format!("RUNTIME_MANIFEST_INVALID: {field} escapes active runtime")); }
    Ok(())
}

fn verify_runtime_contract(root: &Path, manifest: &RuntimeManifest) -> Result<(), String> {
    let node = root.join(&manifest.node_path); let cli = root.join(&manifest.cli_entry); let mcp = root.join(&manifest.mcp_entry);
    let cli_output = Command::new(&node).arg(&cli).arg("capabilities").arg("--json")
        .env("PENGUIN_BUILD_ID", &manifest.build_id)
        .env("PENGUIN_CAPABILITY_HASH", &manifest.capability_hash)
        .env("PENGUIN_SCHEMA_VERSION", manifest.contract_schema_version.to_string())
        .env("PENGUIN_MODEL_HASH", &manifest.model_hash)
        .env("PENGUIN_WASM_DIR", root.join(&manifest.wasm_path)).output().map_err(|e| format!("RUNTIME_VERIFY_FAILED: start CLI probe: {e}"))?;
    if !cli_output.status.success() { return Err(format!("RUNTIME_VERIFY_FAILED: CLI capability probe failed: {}", String::from_utf8_lossy(&cli_output.stderr).trim())); }
    let cli_identity = parse_contract_json(&cli_output.stdout, "CLI")?;
    if cli_identity.0 != manifest.capability_hash || cli_identity.1 != manifest.contract_schema_version || cli_identity.2 != manifest.model_hash { return Err("RUNTIME_CONTRACT_MISMATCH: CLI capability hash, schema, or model differs from manifest".to_string()); }

    let mut child = Command::new(&node).arg(&mcp)
        .env("PENGUIN_BUILD_ID", &manifest.build_id)
        .env("PENGUIN_CAPABILITY_HASH", &manifest.capability_hash)
        .env("PENGUIN_SCHEMA_VERSION", manifest.contract_schema_version.to_string())
        .env("PENGUIN_MODEL_HASH", &manifest.model_hash)
        .env("PENGUIN_WASM_DIR", root.join(&manifest.wasm_path)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("RUNTIME_VERIFY_FAILED: start MCP probe: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let request = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"penguin-runtime-manager","version":"1"}}}
"#;
        stdin.write_all(request.as_bytes()).map_err(|e| format!("RUNTIME_VERIFY_FAILED: send MCP probe: {e}"))?;
    }
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_millis(15)),
            Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("RUNTIME_VERIFY_FAILED: MCP health handshake timed out".to_string()); }
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("RUNTIME_VERIFY_FAILED: wait for MCP probe: {error}")); }
        }
    }
    let output = child.wait_with_output().map_err(|e| format!("RUNTIME_VERIFY_FAILED: read MCP probe: {e}"))?;
    if !output.status.success() { return Err(format!("RUNTIME_VERIFY_FAILED: MCP health probe failed: {}", String::from_utf8_lossy(&output.stderr).trim())); }
    let mcp_identity = parse_mcp_contract(&output.stdout)?;
    if mcp_identity.0 != manifest.capability_hash || mcp_identity.1 != manifest.contract_schema_version || mcp_identity.2 != manifest.model_hash { return Err("RUNTIME_CONTRACT_MISMATCH: MCP capability hash, schema, or model differs from manifest".to_string()); }
    Ok(())
}

fn parse_contract_json(bytes: &[u8], surface: &str) -> Result<(String, u32, String), String> {
    let value = serde_json::from_slice::<serde_json::Value>(bytes).map_err(|e| format!("RUNTIME_VERIFY_FAILED: parse {surface} capability response: {e}"))?;
    let hash = value.get("capabilityHash").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let schema = schema_number(value.get("schemaVersion"))?;
    let model_hash = value.get("modelHash").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if hash.is_empty() || model_hash.is_empty() { return Err(format!("RUNTIME_VERIFY_FAILED: {surface} capability response has no capabilityHash or modelHash")); }
    Ok((hash, schema, model_hash))
}

fn parse_mcp_contract(bytes: &[u8]) -> Result<(String, u32, String), String> {
    for line in String::from_utf8_lossy(bytes).lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        let Some(result) = value.get("result") else { continue; };
        let Some(instructions) = result.get("instructions").and_then(|v| v.as_str()) else { continue; };
        let contract = serde_json::from_str::<serde_json::Value>(instructions).map_err(|e| format!("RUNTIME_VERIFY_FAILED: parse MCP contract instructions: {e}"))?;
        let hash = contract.get("capabilityHash").and_then(|v| v.as_str()).unwrap_or_default().to_string(); let schema = schema_number(contract.get("schemaVersion"))?;
        let model_hash = contract.get("modelHash").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if result.get("serverInfo").and_then(|info| info.get("name")).and_then(|v| v.as_str()) == Some("penguin-mcp") && !hash.is_empty() && !model_hash.is_empty() { return Ok((hash, schema, model_hash)); }
    }
    Err("RUNTIME_VERIFY_FAILED: MCP health handshake had no Penguin contract".to_string())
}

fn schema_number(value: Option<&serde_json::Value>) -> Result<u32, String> {
    if let Some(number) = value.and_then(|v| v.as_u64()) { return u32::try_from(number).map_err(|_| "RUNTIME_VERIFY_FAILED: schemaVersion is too large".to_string()); }
    value.and_then(|v| v.as_str()).ok_or_else(|| "RUNTIME_VERIFY_FAILED: schemaVersion missing".to_string())?.parse::<u32>().map_err(|_| "RUNTIME_VERIFY_FAILED: schemaVersion is invalid".to_string())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    copy_tree_inner(source, target, false)
}

fn copy_tree_without_runtime(source: &Path, target: &Path) -> Result<(), String> {
    copy_tree_inner(source, target, true)
}

fn copy_tree_inner(source: &Path, target: &Path, skip_runtime: bool) -> Result<(), String> {
    if !source.is_dir() { return Err(format!("RUNTIME_NOT_INSTALLED: source bundle missing {}", source.display())); }
    fs::create_dir_all(target).map_err(|e| format!("create staging: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("read {}: {e}", source.display()))? {
        let entry = entry.map_err(|e| e.to_string())?; let from = entry.path(); let to = target.join(entry.file_name());
        if skip_runtime && matches!(entry.file_name().to_str(), Some("node" | "node_modules")) { continue; }
        if fs::metadata(&from).map_err(|e| format!("stat {}: {e}", from.display()))?.is_dir() { copy_tree_inner(&from, &to, false)?; } else { fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?; }
    }
    Ok(())
}

fn hash_tree(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new(); hash_tree_inner(root, root, &mut out)?; Ok(out)
}

fn hash_tree_inner(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?; entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path(); if path.file_name().is_some_and(|name| name == ".ready" || name == "manifest.json") { continue; }
        if fs::metadata(&path).map_err(|e| e.to_string())?.is_dir() { hash_tree_inner(root, &path, out)?; continue; }
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"); let bytes = fs::read(&path).map_err(|e| format!("hash {}: {e}", path.display()))?;
        let mut hash = 0xcbf29ce484222325_u64; for byte in rel.as_bytes().iter().chain(bytes.iter()) { hash ^= u64::from(*byte); hash = hash.wrapping_mul(0x100000001b3); }
        out.insert(rel, format!("{hash:016x}"));
    }
    Ok(())
}

fn write_json(path: &Path, value: &RuntimeManifest) -> Result<(), String> { write_atomic_text(path, &serde_json::to_string_pretty(value).map_err(|e| e.to_string())?) }

fn write_atomic_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = path.with_file_name(format!(".{}.tmp-{}", path.file_name().unwrap_or_default().to_string_lossy(), nonce())); fs::write(&tmp, text).map_err(|e| e.to_string())?; fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn nonce() -> u64 { NONCE.fetch_add(1, Ordering::Relaxed).wrapping_add(std::process::id() as u64) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(name: &str) -> PathBuf { std::env::temp_dir().join(format!("penguin-runtime-{name}-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())) }

    fn source(root: &Path) {
        fs::create_dir_all(root.join("mcp/dist")).unwrap(); fs::create_dir_all(root.join("wasm")).unwrap(); fs::create_dir_all(root.join("node_modules/better-sqlite3/build/Release")).unwrap();
        fs::write(root.join("penguin.mjs"), "cli").unwrap(); fs::write(root.join("mcp/dist/index.js"), "mcp").unwrap(); fs::write(root.join("node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "native").unwrap(); fs::write(root.join("wasm/tree-sitter.wasm"), "wasm").unwrap();
        fs::write(root.join("node"), "#!/bin/sh\ncase \"$1\" in\n  *penguin.mjs) printf '%s\\n' '{\"schemaVersion\":\"18\",\"capabilityHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"modelHash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}' ;;\n  *) printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"serverInfo\":{\"name\":\"penguin-mcp\"},\"instructions\":\"{\\\"schemaVersion\\\":18,\\\"capabilityHash\\\":\\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\",\\\"modelHash\\\":\\\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\\"}\"}}'\n     ;;\nesac\n").unwrap();
        let mut permissions = fs::metadata(root.join("node")).unwrap().permissions(); permissions.set_mode(0o755); fs::set_permissions(root.join("node"), permissions).unwrap();
    }

    fn manifest(build: &str) -> RuntimeManifest { RuntimeManifest { build_id: build.into(), app_version: "1".into(), capability_hash: "a".repeat(64), model_hash: "b".repeat(64), schema_version: 1, contract_schema_version: 18, contract_version: "2".into(), cli_entry: "penguin.mjs".into(), mcp_entry: "mcp/dist/index.js".into(), node_path: "node".into(), wasm_path: "wasm".into(), created_at: "now".into(), file_hashes: BTreeMap::new(), platform: "test".into(), architecture: "test".into(), native_dependencies: Vec::new(), signing: RuntimeSigning::default(), ready: false } }

    #[test]
    fn default_contract_schema_matches_the_schema_18_runtime() {
        assert_eq!(DEFAULT_CONTRACT_SCHEMA_VERSION, 18);
    }

    #[test]
    fn failed_install_does_not_replace_current() { let root = temp("missing"); let manager = KnowledgeRuntimeManager::new(&root); let good = temp("good"); source(&good); manager.install_bundled_knowledge_runtime(&good, manifest("a")).unwrap(); let bad = temp("bad"); fs::create_dir_all(&bad).unwrap(); assert!(manager.install_bundled_knowledge_runtime(&bad, manifest("b")).is_err()); assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "a"); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(good); let _ = fs::remove_dir_all(bad); }

    #[test]
    fn switch_and_rollback_keep_generation_immutable() { let root = temp("rollback"); let manager = KnowledgeRuntimeManager::new(&root); let good = temp("source"); source(&good); manager.install_bundled_knowledge_runtime(&good, manifest("a")).unwrap(); manager.install_bundled_knowledge_runtime(&good, manifest("b")).unwrap(); assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "b"); manager.rollback_knowledge_runtime("a").unwrap(); assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "a"); assert!(root.join("b/.ready").exists()); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(good); }

    #[test]
    fn install_runs_cli_and_mcp_contract_probes_before_activation() { let root = temp("probes"); let good = temp("probe-source"); source(&good); let manager = KnowledgeRuntimeManager::new(&root); let installed = manager.install_bundled_knowledge_runtime(&good, manifest("probe")).unwrap(); assert_eq!(installed.build_id, "probe"); assert_eq!(manager.active_knowledge_runtime().unwrap().contract_schema_version, 18); assert!(installed.file_hashes.contains_key("node")); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(good); }

    #[test]
    fn native_dependency_hashes_are_verified_before_activation() {
        let root = temp("native-hash");
        let good = temp("native-source");
        source(&good);
        let mut checked = manifest("native-good");
        checked.native_dependencies = vec![RuntimeNativeDependency {
            name: "bundled-node".into(),
            version: "test".into(),
            path: "node".into(),
            sha256: sha256_file(&good.join("node")),
            status: "ready".into(),
        }];
        let manager = KnowledgeRuntimeManager::new(&root);
        manager.install_bundled_knowledge_runtime(&good, checked).unwrap();

        fs::write(good.join("node"), "tampered").unwrap();
        let mut bad = manifest("native-bad");
        bad.native_dependencies = vec![RuntimeNativeDependency {
            name: "bundled-node".into(),
            version: "test".into(),
            path: "node".into(),
            sha256: "not-the-hash".into(),
            status: "ready".into(),
        }];
        let error = manager.install_bundled_knowledge_runtime(&good, bad).unwrap_err();
        assert!(error.contains("RUNTIME_HASH_MISMATCH"));
        assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "native-good");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(good);
    }

    #[test]
    fn hash_mismatch_and_contract_mismatch_leave_current_unchanged() { let root = temp("mismatch"); let good = temp("mismatch-source"); source(&good); let manager = KnowledgeRuntimeManager::new(&root); manager.install_bundled_knowledge_runtime(&good, manifest("good")).unwrap(); let mut bad_hash = manifest("bad-hash"); bad_hash.file_hashes.insert("penguin.mjs".into(), "not-the-hash".into()); assert!(manager.install_bundled_knowledge_runtime(&good, bad_hash).unwrap_err().contains("RUNTIME_HASH_MISMATCH")); assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "good"); let mut bad_contract = manifest("bad-contract"); bad_contract.contract_schema_version = 13; assert!(manager.install_bundled_knowledge_runtime(&good, bad_contract).unwrap_err().contains("RUNTIME_CONTRACT_MISMATCH")); assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "good"); assert_eq!(fs::read_dir(&root).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with(".staging-")).count(), 0); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(good); }

    #[test]
    fn missing_native_or_wasm_and_interrupted_staging_are_cleaned_up() { let root = temp("incomplete"); let good = temp("incomplete-source"); source(&good); let manager = KnowledgeRuntimeManager::new(&root); manager.install_bundled_knowledge_runtime(&good, manifest("good")).unwrap(); fs::remove_file(good.join("wasm/tree-sitter.wasm")).unwrap(); assert!(manager.install_bundled_knowledge_runtime(&good, manifest("interrupted")).is_err()); assert_eq!(manager.active_knowledge_runtime().unwrap().build_id, "good"); assert_eq!(fs::read_dir(&root).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with(".staging-")).count(), 0); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(good); }

    #[test]
    fn concurrent_activation_serializes_and_keeps_both_verified_generations() { let root = temp("concurrent"); let first = temp("concurrent-first"); let second = temp("concurrent-second"); source(&first); source(&second); let manager = Arc::new(KnowledgeRuntimeManager::new(&root)); let left = Arc::clone(&manager); let right = Arc::clone(&manager); let first_for_thread = first.clone(); let second_for_thread = second.clone(); let a = thread::spawn(move || left.install_bundled_knowledge_runtime(&first_for_thread, manifest("a"))); let b = thread::spawn(move || right.install_bundled_knowledge_runtime(&second_for_thread, manifest("b"))); assert!(a.join().unwrap().is_ok()); assert!(b.join().unwrap().is_ok()); let active = manager.active_knowledge_runtime().unwrap().build_id; assert!(active == "a" || active == "b"); assert!(root.join("a/.ready").exists()); assert!(root.join("b/.ready").exists()); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(first); let _ = fs::remove_dir_all(second); }

    #[test]
    fn switching_already_current_does_not_rewrite_generation() { let root = temp("already-current"); let good = temp("already-current-source"); source(&good); let manager = KnowledgeRuntimeManager::new(&root); manager.install_bundled_knowledge_runtime(&good, manifest("same")).unwrap(); let before = fs::read(root.join("same/manifest.json")).unwrap(); manager.switch_knowledge_runtime("same").unwrap(); assert_eq!(fs::read(root.join("same/manifest.json")).unwrap(), before); let _ = fs::remove_dir_all(root); let _ = fs::remove_dir_all(good); }
}
