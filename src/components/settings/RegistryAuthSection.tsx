import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { KeyRound, PackageCheck } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";
type ConfiguredStatus = {
  configured: boolean;
  username: string | null;
  registry_url: string | null;
};
type StatusTone = "idle" | "success" | "error";
type WriteRegistryNpmrcResult = string;
const LOG_SCOPE = "RegistryAuthSection";
const STATUS_CLEAR_MS = 5000;
const READ_STATUS_COMMAND = "read_registry_npmrc_status";
const WRITE_NPMRC_COMMAND = "write_registry_npmrc";
const SECTION_TITLE = "Package Registry";
const REGISTRY_HINT = "内部 Nexus 凭证，保存到 ~/.npmrc（安装前自动同步到各协议目录）";
const REGISTRY_URL_LABEL = "Registry URL";
const USERNAME_LABEL = "Username";
const PASSWORD_LABEL = "Password";
const REGISTRY_URL_PLACEHOLDER = "http://sonatype.client88.me/repository/npm_hosted/";
const USERNAME_PLACEHOLDER = "Sonatype 用户名";
const PASSWORD_PLACEHOLDER = "Sonatype 密码";
const SAVE_BUTTON_LABEL = "保存";
const DISABLED_SAVE_TOOLTIP = "请输入 URL、用户名和密码";
const INVALID_CREDENTIAL_MESSAGE = "用户名/密码不能包含 `:` `\\n` `\\r`";
const INVALID_URL_MESSAGE = "Registry URL 必须以 http:// 或 https:// 开头";
const EMPTY_FIELD_MESSAGE = "请输入 URL、用户名和密码";
const SUCCESS_MESSAGE = "已保存到 ~/.npmrc（并同步 grpc-web / grpc / sdk 三个目录）";
const ERROR_MESSAGE_PREFIX = "保存失败：";
const CONFIGURED_PREFIX = "✓ 已配置";
const CONFIGURED_FALLBACK_USERNAME = "";
const NOT_CONFIGURED_LABEL = "⚠ 尚未配置";
const INVALID_CREDENTIAL_PATTERN = /[:\n\r]/;
const INVALID_URL_PATTERN = /[\n\r]/;
const REGISTRY_URL_HTTP_PREFIX = "http://";
const REGISTRY_URL_HTTPS_PREFIX = "https://";
const DEFAULT_REGISTRY_URL = "http://sonatype.client88.me/repository/npm_hosted/";
const DEFAULT_STATUS: ConfiguredStatus = {
  configured: false,
  username: null,
  registry_url: null,
};
export function RegistryAuthSection() {
  logger.info(LOG_SCOPE, "RegistryAuthSection — render entry");
  const [status, setStatus] = useState<ConfiguredStatus>(DEFAULT_STATUS);
  const [registryUrl, setRegistryUrl] = useState(DEFAULT_REGISTRY_URL);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] = useState<StatusTone>("idle");
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearExistingStatusTimer = useCallback((): void => {
    logger.info(LOG_SCOPE, "clearExistingStatusTimer — entry");
    const pendingTimer = statusTimerRef.current;
    const hasPendingTimer = pendingTimer !== null;
    // 业务原因：新的保存结果必须覆盖旧的自动清理任务，避免成功提示被旧计时器提前清掉。
    if (hasPendingTimer) {
      logger.warn(LOG_SCOPE, "clearExistingStatusTimer — 清理旧状态计时器");
      clearTimeout(pendingTimer);
      statusTimerRef.current = null;
    }
    logger.info(LOG_SCOPE, "clearExistingStatusTimer — exit");
  }, []);
  const clearStatusLater = useCallback((): void => {
    logger.info(LOG_SCOPE, "clearStatusLater — entry");
    clearExistingStatusTimer();
    statusTimerRef.current = setTimeout(() => {
      logger.info(LOG_SCOPE, "clearStatusLater.timer — entry");
      setStatusMessage("");
      setStatusTone("idle");
      statusTimerRef.current = null;
      logger.info(LOG_SCOPE, "clearStatusLater.timer — exit");
    }, STATUS_CLEAR_MS);
    logger.info(LOG_SCOPE, "clearStatusLater — exit");
  }, [clearExistingStatusTimer]);
  const loadStatus = useCallback(async (): Promise<void> => {
    logger.info(LOG_SCOPE, "loadStatus — entry");
    try {
      const nextStatus = await invoke<ConfiguredStatus>(READ_STATUS_COMMAND);
      setStatus(nextStatus);
      const hasRecoveredUrl = nextStatus.registry_url !== null && nextStatus.registry_url.length > 0;
      // 业务原因：已配置的 URL 应预填到输入框，让用户直接看到当前 Nexus 指向。
      if (hasRecoveredUrl) {
        setRegistryUrl(nextStatus.registry_url as string);
      }
      logger.info(LOG_SCOPE, "loadStatus — exit", { configured: nextStatus.configured });
    } catch (error) {
      setStatus(DEFAULT_STATUS);
      logger.warn(LOG_SCOPE, "loadStatus — 读取 registry 状态失败，按未配置处理", { error: String(error) });
      logger.info(LOG_SCOPE, "loadStatus — exit", { configured: false });
    }
  }, []);
  useEffect(() => {
    logger.info(LOG_SCOPE, "mountEffect — entry");
    void loadStatus();
    logger.info(LOG_SCOPE, "mountEffect — exit");
    return () => {
      logger.info(LOG_SCOPE, "unmountEffect — entry");
      clearExistingStatusTimer();
      logger.info(LOG_SCOPE, "unmountEffect — exit");
    };
  }, [clearExistingStatusTimer, loadStatus]);
  const handleRegistryUrlChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    logger.info(LOG_SCOPE, "handleRegistryUrlChange — entry");
    setRegistryUrl(event.target.value);
    logger.info(LOG_SCOPE, "handleRegistryUrlChange — exit");
  }, []);
  const handleUsernameChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    logger.info(LOG_SCOPE, "handleUsernameChange — entry");
    setUsername(event.target.value);
    logger.info(LOG_SCOPE, "handleUsernameChange — exit");
  }, []);
  const handlePasswordChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    logger.info(LOG_SCOPE, "handlePasswordChange — entry");
    setPassword(event.target.value);
    logger.info(LOG_SCOPE, "handlePasswordChange — exit");
  }, []);
  const handleSave = useCallback(async (): Promise<void> => {
    logger.info(LOG_SCOPE, "handleSave — entry", { username });
    clearExistingStatusTimer();

    const trimmedUrl = registryUrl.trim();
    const formIncomplete =
      trimmedUrl.length === 0 || username.length === 0 || password.length === 0;
    // 业务原因：缺少任一字段时无法生成 Nexus 凭证或 scope 行，必须阻止写入。
    if (formIncomplete) {
      logger.warn(LOG_SCOPE, "handleSave — URL/用户名/密码 为空");
      setStatusMessage(EMPTY_FIELD_MESSAGE);
      setStatusTone("error");
      logger.info(LOG_SCOPE, "handleSave — exit", { outcome: "empty" });
      return;
    }
    const urlStartsWithHttp = trimmedUrl.startsWith(REGISTRY_URL_HTTP_PREFIX);
    const urlStartsWithHttps = trimmedUrl.startsWith(REGISTRY_URL_HTTPS_PREFIX);
    const urlSchemeIsValid = urlStartsWithHttp || urlStartsWithHttps;
    const urlHasInvalidCharacter = INVALID_URL_PATTERN.test(trimmedUrl);
    const urlIsInvalid = !urlSchemeIsValid || urlHasInvalidCharacter;
    // 业务原因：限定 http/https 防 shell 注入；URL 含换行会破坏 .npmrc 行结构。
    if (urlIsInvalid) {
      logger.warn(LOG_SCOPE, "handleSave — Registry URL 非法");
      setStatusMessage(INVALID_URL_MESSAGE);
      setStatusTone("error");
      logger.info(LOG_SCOPE, "handleSave — exit", { outcome: "invalid_url" });
      return;
    }
    const hasInvalidCredentialCharacter =
      INVALID_CREDENTIAL_PATTERN.test(username) || INVALID_CREDENTIAL_PATTERN.test(password);
    // 业务原因：npm _auth 使用 username:password 拼接，换行或冒号会破坏凭证格式。
    if (hasInvalidCredentialCharacter) {
      logger.warn(LOG_SCOPE, "handleSave — 用户名或密码包含非法字符");
      setStatusMessage(INVALID_CREDENTIAL_MESSAGE);
      setStatusTone("error");
      logger.info(LOG_SCOPE, "handleSave — exit", { outcome: "invalid" });
      return;
    }
    try {
      const result = await invoke<WriteRegistryNpmrcResult>(WRITE_NPMRC_COMMAND, {
        registryUrl: trimmedUrl,
        username,
        password,
      });
      setStatusMessage(SUCCESS_MESSAGE);
      setStatusTone("success");
      setPassword("");
      await loadStatus();
      clearStatusLater();
      logger.info(LOG_SCOPE, "handleSave — success", { result });
      logger.info(LOG_SCOPE, "handleSave — exit", { outcome: "success" });
    } catch (error) {
      const message = `${ERROR_MESSAGE_PREFIX}${String(error)}`;
      setStatusMessage(message);
      setStatusTone("error");
      logger.error(LOG_SCOPE, "handleSave — 保存 registry 凭证失败", error);
      logger.info(LOG_SCOPE, "handleSave — exit", { outcome: "error" });
    }
  }, [clearExistingStatusTimer, clearStatusLater, loadStatus, password, registryUrl, username]);
  const saveDisabled =
    registryUrl.trim().length === 0 || username.length === 0 || password.length === 0;
  const statusUsername = status.username ?? CONFIGURED_FALLBACK_USERNAME;
  const configuredLabel = `${CONFIGURED_PREFIX}（${statusUsername}）`;
  const registryStatusLabel = status.configured ? configuredLabel : NOT_CONFIGURED_LABEL;
  const registryStatusClassName = status.configured ? "text-emerald-500" : "text-muted-foreground";
  const messageClassName = statusTone === "success" ? "text-emerald-500" : "text-destructive";
  const saveButtonTitle = saveDisabled ? DISABLED_SAVE_TOOLTIP : SAVE_BUTTON_LABEL;
  logger.info(LOG_SCOPE, "RegistryAuthSection — render exit", { configured: status.configured });
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <PackageCheck className="h-3.5 w-3.5" />
            {SECTION_TITLE}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{REGISTRY_HINT}</p>
        </div>
        <p className={cn("shrink-0 text-xs font-medium", registryStatusClassName)}>
          {registryStatusLabel}
        </p>
      </div>
      <label className="mt-3 block text-xs text-muted-foreground">
        {REGISTRY_URL_LABEL}
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={registryUrl}
          onChange={handleRegistryUrlChange}
          placeholder={REGISTRY_URL_PLACEHOLDER}
          className="mt-1"
        />
      </label>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="block min-w-0 text-xs text-muted-foreground">
          {USERNAME_LABEL}
          <Input
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={username}
            onChange={handleUsernameChange}
            placeholder={USERNAME_PLACEHOLDER}
            className="mt-1"
          />
        </label>
        <label className="block min-w-0 text-xs text-muted-foreground">
          {PASSWORD_LABEL}
          <Input
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            value={password}
            onChange={handlePasswordChange}
            placeholder={PASSWORD_PLACEHOLDER}
            className="mt-1"
          />
        </label>
        <Button size="sm" onClick={handleSave} disabled={saveDisabled} title={saveButtonTitle}>
          <KeyRound className="mr-1.5 h-3.5 w-3.5" />
          {SAVE_BUTTON_LABEL}
        </Button>
      </div>
      {statusMessage.length > 0 ? (
        <p className={cn("mt-2 text-xs", messageClassName)}>{statusMessage}</p>
      ) : null}
    </div>
  );
}
