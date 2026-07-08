import {
  deleteAppValueFromDatabase,
  loadAppValuesFromDatabase,
  setAppValueInDatabase,
} from "./penguin-db";
import { LEGACY_BROWSER_STORAGE_KEYS } from "./persistence-keys";

let cache: Record<string, string> = {};
let hydratePromise: Promise<Record<string, string>> | null = null;
const writeTails = new Map<string, Promise<void>>();

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function migrateBrowserStorageToDatabase(): Promise<void> {
  const storage = browserStorage();
  if (!storage) return;

  const migratedKeys: string[] = [];
  for (const key of LEGACY_BROWSER_STORAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      migratedKeys.push(key);
      continue;
    }
    const value = storage.getItem(key);
    if (value === null) continue;
    const persisted = await setAppValueInDatabase(key, value);
    if (!persisted) return;
    cache[key] = value;
    migratedKeys.push(key);
  }

  for (const key of migratedKeys) {
    storage.removeItem(key);
  }
}

export async function hydratePersistedValues(): Promise<Record<string, string>> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    cache = await loadAppValuesFromDatabase();
    await migrateBrowserStorageToDatabase();
    return { ...cache };
  })();
  return hydratePromise;
}

export function getPersistedValue(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
}

export function setPersistedValue(key: string, value: string): void {
  cache[key] = value;
  enqueueWrite(key, () => setAppValueInDatabase(key, value));
}

export function deletePersistedValue(key: string): void {
  delete cache[key];
  enqueueWrite(key, () => deleteAppValueFromDatabase(key));
}

function enqueueWrite(key: string, operation: () => Promise<unknown>): void {
  const previous = writeTails.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .then(
      () => undefined,
      () => undefined,
    );
  writeTails.set(key, next);
  void next.finally(() => {
    if (writeTails.get(key) === next) {
      writeTails.delete(key);
    }
  });
}
