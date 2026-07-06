// SSH tunnel for Redis — spawns `ssh -L` subprocess for port forwarding.
// Avoids russh API compatibility issues; macOS always has /usr/bin/ssh.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout, Duration};

pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String, // "password" | "key"
    pub password: String,
    pub key_path: String,
}

/// A live tunnel. The ssh child process outlives this handle if dropped
/// without `shutdown()` — the owner (connection registry) must call it when
/// the Redis connection closes, or the process leaks.
pub struct SshTunnel {
    pub local_port: u16,
    child: Child,
}

impl SshTunnel {
    pub async fn shutdown(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

fn effective_port(port: u16) -> u16 {
    if port == 0 {
        22
    } else {
        port
    }
}

/// Locate sshpass. GUI apps on macOS get launchd's minimal PATH (no
/// /opt/homebrew/bin), so the Homebrew/MacPorts locations are probed
/// explicitly before falling back to a PATH scan.
fn find_sshpass() -> Option<PathBuf> {
    const KNOWN: [&str; 3] = [
        "/opt/homebrew/bin/sshpass",
        "/usr/local/bin/sshpass",
        "/opt/local/bin/sshpass",
    ];
    for candidate in KNOWN {
        if Path::new(candidate).is_file() {
            return Some(PathBuf::from(candidate));
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("sshpass"))
        .find(|p| p.is_file())
}

/// SSH argument list shared by both auth modes. Password mode must allow the
/// prompt sshpass answers; key mode sets BatchMode so a key that needs
/// interaction (e.g. passphrase-protected) fails immediately instead of
/// hanging against the null stdin until the 8s timeout.
fn build_ssh_args(ssh: &SshConfig, forward: &str, use_password: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-N",
        "-L", forward,
        "-p", &effective_port(ssh.port).to_string(),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    if use_password {
        args.extend(["-o", "NumberOfPasswordPrompts=1"].map(String::from));
    } else {
        args.extend(["-o", "BatchMode=yes"].map(String::from));
        if !ssh.key_path.is_empty() {
            args.push("-i".to_string());
            args.push(ssh.key_path.clone());
        }
    }
    args.push(format!("{}@{}", ssh.username, ssh.host));
    args
}

/// Start an SSH port-forward tunnel to `target_host:target_port` and wait up
/// to 8s for the local end to become reachable.
pub async fn start_tunnel(
    ssh: &SshConfig,
    target_host: &str,
    target_port: u16,
) -> Result<SshTunnel, String> {
    // Find a free local port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind failed: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {e}"))?
        .port();
    drop(listener); // release the port so ssh can bind it

    let forward = format!("127.0.0.1:{local_port}:{target_host}:{target_port}");
    let use_password = ssh.auth_type == "password" && !ssh.password.is_empty();

    let mut cmd = if use_password {
        let Some(sshpass) = find_sshpass() else {
            return Err(
                "SSH 密码认证需要 sshpass（macOS 未预装）。请运行 `brew install sshpass` 后重试，或改用 SSH Key 认证。"
                    .to_string(),
            );
        };
        let mut c = Command::new(sshpass);
        c.env("SSHPASS", &ssh.password);
        c.arg("-e").arg("ssh");
        c
    } else {
        Command::new("ssh")
    };
    cmd.args(build_ssh_args(ssh, &forward, use_password));

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;

    // Wait for the local port to become available (up to 8s). Bail out early
    // if ssh already exited (auth failure, BatchMode refusal, bad host).
    let addr = format!("127.0.0.1:{local_port}");
    let result = timeout(Duration::from_secs(8), async {
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                return Err(());
            }
            if TcpStream::connect(&addr).await.is_ok() {
                return Ok(());
            }
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await;

    match result {
        Ok(Ok(())) => Ok(SshTunnel { local_port, child }),
        _ => {
            let _ = child.kill().await;
            let stderr = child
                .wait_with_output()
                .await
                .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
                .unwrap_or_default();
            Err(format!("SSH tunnel failed to establish: {stderr}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(auth_type: &str, key_path: &str, port: u16) -> SshConfig {
        SshConfig {
            host: "jump.example.com".into(),
            port,
            username: "deploy".into(),
            auth_type: auth_type.into(),
            password: "secret".into(),
            key_path: key_path.into(),
        }
    }

    #[test]
    fn port_zero_defaults_to_22() {
        assert_eq!(effective_port(0), 22);
        assert_eq!(effective_port(8), 8);
        assert_eq!(effective_port(2222), 2222);
    }

    #[test]
    fn key_mode_uses_batchmode_and_identity_file() {
        let args = build_ssh_args(&config("key", "/home/k/id_ed25519", 2222), "fwd", false);
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"/home/k/id_ed25519".to_string()));
        assert!(!args.contains(&"NumberOfPasswordPrompts=1".to_string()));
        assert!(args.contains(&"2222".to_string()));
        assert_eq!(args.last().unwrap(), "deploy@jump.example.com");
    }

    #[test]
    fn password_mode_allows_prompt_and_skips_identity() {
        let args = build_ssh_args(&config("password", "/home/k/id_ed25519", 0), "fwd", true);
        assert!(args.contains(&"NumberOfPasswordPrompts=1".to_string()));
        assert!(!args.contains(&"BatchMode=yes".to_string()));
        assert!(!args.contains(&"-i".to_string()));
        assert!(args.contains(&"22".to_string())); // port 0 → default 22
    }
}
