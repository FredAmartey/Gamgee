import type { GenParams } from "@/app/components/Gallery";

/**
 * On-device logo history (IndexedDB). Account-less persistence: survives
 * reloads, never leaves the browser. Images are stored as Blobs (data URLs are
 * 1-2 MB each and would blow localStorage's ~5 MB quota). Every call is
 * SSR-guarded and resolves to a safe default if IndexedDB is unavailable
 * (private mode, blocked), so the app silently falls back to in-memory only.
 */

export type HistoryRecord = {
  id: string;
  companyName: string;
  params: GenParams;
  createdAt: number;
  blob: Blob;
  favorite?: boolean;
  name?: string; // user-given label, overrides companyName for display
  /**
   * The custom folder this logo is filed in, if any. A logo belongs to at most
   * one: filing is a move, not a tag. Brand grouping is separate and needs no
   * field here, since it's derived from `companyName` at read time.
   */
  folderId?: string;
};

/** A user-created folder. Membership lives on the logo, as `folderId`. */
export type FolderRecord = {
  id: string;
  name: string;
  createdAt: number;
};

/** One built asset inside a saved brand kit (blob + enough to rebuild the tile). */
export type KitAsset = {
  path: string; // zip-relative filename, e.g. "variants/logo-on-light.png"
  group: string;
  name: string;
  /** Metered AI render (restored tiles keep honest cost counts). */
  ai?: boolean;
  hidden: boolean;
  blob: Blob;
};

/**
 * A completed brand kit, saved against the logo it was built for so re-opening
 * that logo restores the kit instantly instead of rebuilding (which would
 * re-spend on the paid AI assets). Keyed by the logo's id.
 */
export type KitRecord = {
  logoId: string;
  companyName: string;
  createdAt: number;
  palette: string[];
  aiCount: number; // how many paid AI assets it holds (drives the "saved you $" note)
  files: KitAsset[];
};

const DB_NAME = "gamgee";
const STORE = "logos";
const KIT_STORE = "kits";
const FOLDER_STORE = "folders";
// Kits are heavy (every asset is a Blob), so keep only the most recent few; the
// createdAt index lets us evict the oldest without loading any blobs.
const KIT_CAP = 8;
const VERSION = 3;

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

// One cached connection for the whole session. A 4-variation batch fires four
// parallel saves; opening/closing per call ran the open handshake four times
// concurrently for nothing. The browser closes it with the page; if another
// tab upgrades the schema (versionchange) we close and reopen on next use.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      // v2: brand kits, keyed by the logo id, indexed by createdAt for eviction.
      if (!db.objectStoreNames.contains(KIT_STORE)) {
        const kits = db.createObjectStore(KIT_STORE, { keyPath: "logoId" });
        kits.createIndex("createdAt", "createdAt");
      }
      // v3: custom folders. Purely additive, so an existing database upgrades
      // in place with every logo and kit untouched.
      if (!db.objectStoreNames.contains(FOLDER_STORE)) {
        const folders = db.createObjectStore(FOLDER_STORE, { keyPath: "id" });
        folders.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null; // let the next call retry
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
  store: string = STORE,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    run(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveLogo(rec: HistoryRecord): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.put(rec));
}

/**
 * Newest-first records straight off the createdAt index (no full-store load +
 * JS sort). `limit` bounds how many Blobs are materialized into memory; omit
 * it for everything.
 */
export async function getAllLogos(limit = Infinity): Promise<HistoryRecord[]> {
  if (!available()) return [];
  const db = await openDb();
  return new Promise<HistoryRecord[]>((resolve, reject) => {
    const recs: HistoryRecord[] = [];
    const index = db
      .transaction(STORE, "readonly")
      .objectStore(STORE)
      .index("createdAt");
    const req = index.openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && recs.length < limit) {
        recs.push(cursor.value as HistoryRecord);
        cursor.continue();
      } else {
        resolve(recs);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Update a stored logo's metadata (favorite / name / folder) without touching
 * its blob. A `folderId` of null unfiles the logo, dropping the key entirely
 * rather than storing a null (so `folderId in rec` stays a reliable test).
 */
export async function patchLogo(
  id: string,
  patch: { favorite?: boolean; name?: string; folderId?: string | null },
): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result as HistoryRecord | undefined;
      if (rec) {
        const next = { ...rec, ...patch } as HistoryRecord;
        if (patch.folderId === null) delete next.folderId;
        store.put(next);
      } else {
        // Reject rather than silently no-op so the caller can surface that a
        // favorite/rename didn't persist (instead of it vanishing on reload).
        reject(new Error("record not found"));
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function deleteLogo(id: string): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.delete(id));
}

export async function clearLogos(): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.clear());
}

// ── Folders ─────────────────────────────────────────────────────────────────

/** Create or rename a folder (same call: the record is keyed by id). */
export async function saveFolder(rec: FolderRecord): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.put(rec), FOLDER_STORE);
}

/** Every folder, oldest-first, so the rail order matches creation order. */
export async function getAllFolders(): Promise<FolderRecord[]> {
  if (!available()) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(FOLDER_STORE, "readonly")
      .objectStore(FOLDER_STORE)
      .index("createdAt")
      .getAll();
    req.onsuccess = () => resolve((req.result ?? []) as FolderRecord[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a folder and unfile its logos. Deliberately never deletes the logos
 * themselves: a folder is a view onto them, and losing artwork to a tidy-up
 * would be unforgivable. Both stores move in ONE transaction, so a failure
 * can't leave logos pointing at a folder that no longer exists.
 */
export async function deleteFolder(id: string): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE, FOLDER_STORE], "readwrite");
    t.objectStore(FOLDER_STORE).delete(id);
    // Walk the logos rather than index on folderId: histories are small (a few
    // hundred rows at most) and this keeps the schema free of an index that
    // would need its own migration.
    const cursorReq = t.objectStore(STORE).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const rec = cursor.value as HistoryRecord;
      if (rec.folderId === id) {
        const next = { ...rec };
        delete next.folderId;
        cursor.update(next);
      }
      cursor.continue();
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function clearFolders(): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.clear(), FOLDER_STORE);
}

// ── Brand kits ──────────────────────────────────────────────────────────────

/** Save (or replace) a logo's brand kit, then evict the oldest beyond KIT_CAP. */
export async function saveKit(rec: KitRecord): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.put(rec), KIT_STORE);
  // Cheap eviction: index.getAllKeys() returns primary keys in createdAt order,
  // so the head of the list is the oldest, none of it loads a blob.
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const req = db
      .transaction(KIT_STORE, "readonly")
      .objectStore(KIT_STORE)
      .index("createdAt")
      .getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (keys.length > KIT_CAP) {
    const stale = keys.slice(0, keys.length - KIT_CAP);
    await tx(
      db,
      "readwrite",
      (s) => stale.forEach((k) => s.delete(k)),
      KIT_STORE,
    );
  }
}

/** The full saved kit for a logo (with every asset blob), or undefined. */
export async function getKit(logoId: string): Promise<KitRecord | undefined> {
  if (!available()) return undefined;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(KIT_STORE, "readonly")
      .objectStore(KIT_STORE)
      .get(logoId);
    req.onsuccess = () => resolve(req.result as KitRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Just the logo ids that have a saved kit (no blobs loaded), for the badges. */
export async function getKitIds(): Promise<string[]> {
  if (!available()) return [];
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(KIT_STORE, "readonly")
      .objectStore(KIT_STORE)
      .getAllKeys();
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteKit(logoId: string): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.delete(logoId), KIT_STORE);
}

export async function clearKits(): Promise<void> {
  if (!available()) return;
  const db = await openDb();
  await tx(db, "readwrite", (s) => s.clear(), KIT_STORE);
}
