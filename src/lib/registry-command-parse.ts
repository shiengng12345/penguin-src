// Parse an internal-registry credential that a user pastes as an npm command,
// e.g.
//   npm config set //sonatype.client88.me/repository/npm_hosted/:_auth="$(echo -n snsoft-read:snsoft-read123 | base64)"
// into the three Settings fields. Pure + framework-free so it unit-tests
// without a DOM. Returns null for anything that isn't such a command, so the
// caller can fall back to treating the input as a plain Registry URL.

export interface ParsedRegistryCommand {
  registryUrl: string;
  username: string;
  password: string;
}

// host[:port]/path/ between "//" and ":_auth=" (the npm per-registry auth key).
const AUTH_KEY_HOST_PATH = /\/\/([^\s"']+?):_auth=/;
// `echo -n user:pass` (the -n flag and surrounding quotes are optional).
const ECHO_CREDENTIAL = /echo\s+(?:-n\s+)?["']?([^\s|"']+)["']?/;
// A literal base64 value right after `:_auth=` (bare ~/.npmrc line, already encoded).
const LITERAL_AUTH_VALUE = /:_auth=\s*["']?([A-Za-z0-9+/=]+)["']?/;

function decodeBase64(value: string): string | null {
  try {
    // atob exists in the Tauri webview and in Node 16+ (test runtime).
    return atob(value);
  } catch {
    return null;
  }
}

// `currentScheme` comes from whatever protocol is already in the Registry URL
// field — the pasted `//host` form carries no scheme, so we keep the user's
// (default http, or https if they'd switched it). Never guess/downgrade.
export function parseRegistryCommand(
  input: string,
  currentScheme: "http" | "https",
): ParsedRegistryCommand | null {
  const hostMatch = input.match(AUTH_KEY_HOST_PATH);
  if (!hostMatch) return null;
  const hostPath = hostMatch[1];

  // Prefer the plaintext from `echo -n user:pass`; otherwise decode a literal
  // base64 _auth value (supports pasting a raw already-encoded .npmrc line).
  let credential: string | null = null;
  const echoMatch = input.match(ECHO_CREDENTIAL);
  if (echoMatch) {
    credential = echoMatch[1];
  } else {
    const literalMatch = input.match(LITERAL_AUTH_VALUE);
    if (literalMatch) credential = decodeBase64(literalMatch[1]);
  }
  if (!credential) return null;

  const colonIndex = credential.indexOf(":");
  if (colonIndex < 0) return null;
  const username = credential.slice(0, colonIndex);
  const password = credential.slice(colonIndex + 1);
  if (!username || !password) return null;

  return {
    registryUrl: `${currentScheme}://${hostPath}`,
    username,
    password,
  };
}
