/**
 * Google sign-in and the few Drive calls the backup needs (0.11). Everything goes from the tablet straight
 * to Google: there is no server of ours. The permission is `drive.file`: the app sees only the files and
 * folders it made (or that he picked in Google's own folder picker), nothing else in his Drive.
 *
 * Sign-in: Google Identity Services' popup (the token lasts about an hour, kept in memory and this tab's
 * sessionStorage, never in localStorage or a backup). Where the popup can't open (an installed app on some
 * Android versions), the same sign-in runs on a full page and comes back to the app with the token.
 */
import { DRIVE_SCOPE, FOLDER_NAME, GOOGLE_API_KEY, GOOGLE_APP_ID, GOOGLE_CLIENT_ID } from './drive-config';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TOKEN_KEY = 'upsc.driveToken'; // sessionStorage: survives the full-page sign-in, not the app being closed
const REDIRECT_KEY = 'upsc.driveRedirect';
/** appProperties tag on everything the app makes, so it never touches another file. */
const TAG = 'upscNotes';

export type DriveErrorKind = 'auth' | 'offline' | 'gone' | 'http';
export class DriveError extends Error {
  constructor(
    public kind: DriveErrorKind,
    message: string,
    public status?: number
  ) {
    super(message);
  }
}

export interface DriveFile {
  id: string;
  name: string;
  size?: string;
  createdTime?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

/** What a sign-in came to: a token, he closed or refused it, or the popup could not open at all. */
export type SignIn = 'ok' | 'cancelled' | 'denied' | 'popup-failed' | 'offline';

// ---------- the token ----------
let token: { value: string; exp: number } | null = (() => {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    return t && typeof t.value === 'string' && typeof t.exp === 'number' ? t : null;
  } catch {
    return null;
  }
})();

export function hasToken(): boolean {
  return !!token && token.exp > Date.now();
}

function setToken(value: string, expiresIn: number) {
  // treated as expired a minute early, so a backup never starts on a token about to run out
  token = { value, exp: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  } catch {
    /* memory only */
  }
}

export function forgetToken() {
  token = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing kept */
  }
}

const grantsDrive = (scope: string | null | undefined) => !!scope && scope.split(/\s+/).includes(DRIVE_SCOPE);

// ---------- Google's scripts, loaded only when Drive is used ----------
interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string; login_hint?: string }): void;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
type GoogleNS = any;
declare global {
  interface Window {
    google?: GoogleNS;
    gapi?: GoogleNS;
  }
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        s.remove();
        scripts.delete(src);
        reject(new DriveError('offline', "Google couldn't be reached. Check the internet and try again."));
      };
      document.head.append(s);
    });
    scripts.set(src, p);
  }
  return p;
}

export const gisReady = () => !!window.google?.accounts?.oauth2;

/** Loads Google's sign-in script ahead of the tap that needs it (a popup must open within the tap). */
export function loadGis(): Promise<void> {
  if (gisReady()) return Promise.resolve();
  if (!navigator.onLine) return Promise.reject(new DriveError('offline', 'No internet.'));
  return loadScript('https://accounts.google.com/gsi/client');
}

let client: TokenClient | null = null;
let pending: ((r: SignIn) => void) | null = null;

function settle(r: SignIn) {
  const p = pending;
  pending = null;
  p?.(r);
}

/**
 * Google's sign-in popup. Call it inside a tap. `silent` renews an earlier permission: Google's window
 * flashes and closes by itself when he is still signed in.
 */
export async function signInPopup(opts: { silent: boolean; hint?: string }): Promise<SignIn> {
  if (!gisReady()) {
    try {
      await loadGis();
    } catch {
      return 'offline';
    }
  }
  client ??= window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (r: TokenResponse) => {
      if (r.access_token && grantsDrive(r.scope ?? DRIVE_SCOPE)) {
        setToken(r.access_token, Number(r.expires_in) || 3600);
        settle('ok');
      } else settle(r.error === 'access_denied' || r.access_token ? 'denied' : 'cancelled');
    },
    error_callback: (e: { type?: string }) => settle(e?.type === 'popup_failed_to_open' ? 'popup-failed' : 'cancelled')
  }) as TokenClient;
  return new Promise<SignIn>((resolve) => {
    settle('cancelled'); // an older request still waiting is over
    pending = resolve;
    try {
      client!.requestAccessToken({ prompt: opts.silent ? '' : 'select_account', ...(opts.hint ? { login_hint: opts.hint } : {}) });
    } catch {
      settle('popup-failed');
    }
  });
}

/** Ends a sign-in still waiting (he cancelled our "waiting for Google" sheet). */
export function abandonSignIn() {
  settle('cancelled');
}

/** The same sign-in on a full page: the app is left and opened again with the token. */
export function signInRedirect(opts: { silent: boolean; hint?: string; then: string }) {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(REDIRECT_KEY, JSON.stringify({ state, back: location.hash || '#/', then: opts.then, silent: opts.silent }));
  } catch {
    /* without sessionStorage the answer can't be checked: it will be refused */
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: location.origin + import.meta.env.BASE_URL,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    include_granted_scopes: 'true',
    state,
    prompt: opts.silent ? 'none' : 'select_account',
    ...(opts.hint ? { login_hint: opts.hint } : {})
  }).toString();
  location.assign(url.toString());
}

/**
 * At launch, before the first screen: a full-page sign-in that just came back. Takes the token out of
 * the address (it never stays in the history) and returns to the screen he was on.
 */
export function takeRedirectResult(): { result: SignIn; then: string; silent: boolean } | null {
  const hash = location.hash;
  if (!/^#(.*&)?(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash.slice(1));
  let saved: { state?: string; back?: string; then?: string; silent?: boolean } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(REDIRECT_KEY) ?? 'null');
    sessionStorage.removeItem(REDIRECT_KEY);
  } catch {
    saved = null;
  }
  const back = saved?.back && saved.back.startsWith('#') ? saved.back : '#/';
  history.replaceState(null, '', location.pathname + location.search + back);
  if (!saved || !saved.state || p.get('state') !== saved.state) return { result: 'cancelled', then: '', silent: false };
  let result: SignIn;
  const access = p.get('access_token');
  if (access && grantsDrive(p.get('scope') ?? DRIVE_SCOPE)) {
    setToken(access, Number(p.get('expires_in')) || 3600);
    result = 'ok';
  } else result = p.get('error') === 'access_denied' || access ? 'denied' : 'cancelled';
  return { result, then: saved.then ?? '', silent: !!saved.silent };
}

export function revokeAccess() {
  const t = token?.value;
  forgetToken();
  try {
    if (t && gisReady()) window.google.accounts.oauth2.revoke(t, () => {});
  } catch {
    /* the permission stays listed in his Google account; he can remove it there */
  }
}

// ---------- Drive calls ----------
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  if (!navigator.onLine) throw new DriveError('offline', 'No internet.');
  if (!hasToken()) throw new DriveError('auth', 'Google sign-in has run out.');
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token!.value}`, ...(init.headers ?? {}) } });
  } catch {
    throw new DriveError('offline', "Google Drive couldn't be reached.");
  }
  if (r.status === 401) {
    forgetToken();
    throw new DriveError('auth', 'Google sign-in has run out.', 401);
  }
  if (r.status === 404) throw new DriveError('gone', 'Not found in Google Drive.', 404);
  if (!r.ok) {
    const quota = r.status === 403 && /storageQuotaExceeded/.test(await r.clone().text().catch(() => ''));
    throw new DriveError('http', quota ? 'Google Drive is full.' : `Google Drive said no (${r.status}).`, r.status);
  }
  return r;
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const q = (s: string) => encodeURIComponent(s);

export async function account(): Promise<{ name: string; email: string }> {
  const r = await json<{ user?: { displayName?: string; emailAddress?: string } }>(await call(`${API}/about?fields=user(displayName,emailAddress)`));
  return { name: r.user?.displayName ?? '', email: r.user?.emailAddress ?? '' };
}

/** A folder the app can write to, or null when it is gone or in Drive's trash. */
export async function folderInfo(id: string): Promise<DriveFile | null> {
  try {
    const f = await json<DriveFile>(await call(`${API}/files/${q(id)}?fields=id,name,trashed`));
    return f.trashed ? null : f;
  } catch (e) {
    if (e instanceof DriveError && e.kind === 'gone') return null;
    throw e;
  }
}

/** "UPSC Notes backups": the one the app made before (this or another device), or a new one in My Drive. */
export async function ourFolder(): Promise<DriveFile> {
  const query = `mimeType='${FOLDER_MIME}' and appProperties has { key='${TAG}' and value='folder' } and trashed=false`;
  const found = await json<{ files: DriveFile[] }>(await call(`${API}/files?q=${q(query)}&fields=files(id,name)&orderBy=createdTime&pageSize=10&spaces=drive`));
  if (found.files?.length) return found.files[0];
  return json<DriveFile>(
    await call(`${API}/files?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { [TAG]: 'folder' } })
    })
  );
}

const FILE_FIELDS = 'id,name,size,createdTime,parents,appProperties';

/** A backup file into the folder, in two steps (Drive's single-request upload stops at 5 MB). */
export async function upload(blob: Blob, name: string, folderId: string, props: Record<string, string>): Promise<DriveFile> {
  const start = await call(`${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/json',
      'X-Upload-Content-Length': String(blob.size)
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType: 'application/json', appProperties: { ...props, [TAG]: 'backup' } })
  });
  // Drive names the upload address in Location; the upload id it always exposes builds the same address.
  const uploadId = start.headers.get('X-GUploader-UploadID');
  const session = start.headers.get('Location') ?? (uploadId ? `${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}&upload_id=${q(uploadId)}` : null);
  if (!session) throw new DriveError('http', "Google Drive didn't accept the upload.");
  return json<DriveFile>(await call(session, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: blob }));
}

/** The app's backups, newest first: in one folder, or (restore on a new device) wherever they are. */
export async function listBackups(folderId?: string): Promise<DriveFile[]> {
  let query = `appProperties has { key='${TAG}' and value='backup' } and trashed=false`;
  if (folderId) query += ` and '${folderId.replace(/'/g, '')}' in parents`;
  const out: DriveFile[] = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const r = await json<{ files: DriveFile[]; nextPageToken?: string }>(
      await call(`${API}/files?q=${q(query)}&fields=nextPageToken,files(${FILE_FIELDS})&orderBy=createdTime desc&pageSize=100&spaces=drive${page ? `&pageToken=${q(page)}` : ''}`)
    );
    out.push(...(r.files ?? []));
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
  }
  return out.sort((a, b) => String(b.createdTime ?? '').localeCompare(String(a.createdTime ?? '')));
}

export async function download(id: string): Promise<string> {
  return (await call(`${API}/files/${q(id)}?alt=media`)).text();
}

/** Into his Drive's trash (Google keeps it there 30 days), never deleted outright. */
export async function trashFile(id: string): Promise<void> {
  await call(`${API}/files/${q(id)}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ trashed: true })
  });
}

/** Google's own folder picker; the folder he picks becomes one the app may write to. Null if he cancels. */
export async function pickFolder(): Promise<{ id: string; name: string } | null> {
  if (!hasToken()) throw new DriveError('auth', 'Google sign-in has run out.');
  if (!window.google?.picker) {
    if (!window.gapi) await loadScript('https://apis.google.com/js/api.js');
    await new Promise<void>((resolve, reject) => window.gapi.load('picker', { callback: resolve, onerror: reject }));
  }
  const gp = window.google.picker;
  const view = new gp.DocsView(gp.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME);
  return new Promise((resolve) => {
    new gp.PickerBuilder()
      .addView(view)
      .setOAuthToken(token!.value)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setAppId(GOOGLE_APP_ID)
      .setTitle('Choose a folder for backups')
      .setCallback((d: { action: string; docs?: { id: string; name: string }[] }) => {
        if (d.action === gp.Action.PICKED && d.docs?.[0]) resolve({ id: d.docs[0].id, name: d.docs[0].name });
        else if (d.action === gp.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
