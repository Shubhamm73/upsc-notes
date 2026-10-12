import { setMeta } from '../db';

export interface StorageStatus {
  persisted: boolean | null; // null = browser can't tell us
  usageMB: number | null;
  quotaMB: number | null;
}

/** Ask the browser not to clear this app's data when space runs low. Safe to call repeatedly. */
export async function ensurePersistence(): Promise<boolean | null> {
  const s = navigator.storage;
  if (!s?.persisted) return null;
  let granted = await s.persisted();
  if (!granted && s.persist) granted = await s.persist();
  await setMeta('persistGranted', granted);
  return granted;
}

export async function storageStatus(): Promise<StorageStatus> {
  const s = navigator.storage;
  const persisted = s?.persisted ? await s.persisted() : null;
  let usageMB: number | null = null;
  let quotaMB: number | null = null;
  if (s?.estimate) {
    const e = await s.estimate();
    usageMB = e.usage != null ? e.usage / 1_048_576 : null;
    quotaMB = e.quota != null ? e.quota / 1_048_576 : null;
  }
  return { persisted, usageMB, quotaMB };
}

export function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}
