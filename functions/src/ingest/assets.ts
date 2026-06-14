/**
 * Vault image/diagram assets — pure helpers + the Storage upload step.
 *
 * Obsidian notes embed images (`![[er-diagram.png]]`, `![](img/cpu.png)`). The
 * parser captures those references on `ParsedNote.imageEmbeds`; this module turns
 * the ones whose bytes the archive actually carries into Cloud Storage objects
 * with stable, tokenized download URLs, and attaches a per-concept asset map so
 * the web renderer can resolve `![[name]]` to a real URL.
 *
 * The PURE parts (`imageExtensions`, `normaliseAssetName`, `assetBasename`,
 * `contentTypeFor`, `tokenizedUrl`) are unit-tested in `assets.test.ts`. The
 * upload (`uploadVaultAssets`) is impure (Storage) and exercised live by the
 * orchestrator.
 */
import crypto from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import type { Concept } from "@tutor/shared";
import type { ParsedNote } from "./index";

/** Recognised image extensions (no leading dot, lowercase). */
export const imageExtensions = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
] as const;

/** Map an image extension to a Content-Type; `application/octet-stream` if unknown. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
};

/** Skip any single image larger than this (free-tier guard). */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024; // ~10 MB

/**
 * Reduce an embed reference to its matchable basename: drop any directory
 * prefix, any `|alias`/`|size` suffix, any `?query`/`#hash`, and lowercase it.
 * Both the embed-as-written and the archive entry name normalise through here so
 * `![[img/cpu.png|200]]`, `![](./img/cpu.png)` and a zip entry `assets/CPU.png`
 * all collapse to the same key (`cpu.png`).
 */
export function normaliseAssetName(reference: string): string {
  let ref = reference.trim();
  // Drop an Obsidian alias/size suffix ("name|200").
  const pipe = ref.indexOf("|");
  if (pipe !== -1) ref = ref.slice(0, pipe);
  // Drop URL query/hash.
  ref = ref.split(/[?#]/, 1)[0] ?? ref;
  // Normalise separators and take the last path segment.
  ref = ref.replace(/\\/g, "/");
  const base = ref.split("/").pop() ?? ref;
  return base.trim().toLowerCase();
}

/** The lowercased extension of an asset reference, or "" if it has none. */
export function assetExtension(reference: string): string {
  const base = normaliseAssetName(reference);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1);
}

/** Content-Type for an asset reference, by extension. */
export function contentTypeFor(reference: string): string {
  return CONTENT_TYPE_BY_EXT[assetExtension(reference)] ?? "application/octet-stream";
}

/**
 * A Storage-safe object filename for an asset: its normalised basename with any
 * remaining unsafe characters collapsed to `-`. Keeps the extension. Used as the
 * final path segment under the per-import asset prefix.
 */
export function safeAssetFileName(reference: string): string {
  const base = normaliseAssetName(reference);
  const safe = base.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe || "asset";
}

/** Per-import Storage prefix for a user's vault assets. */
export function assetStoragePrefix(uid: string, importId: string): string {
  return `users/${uid}/vault-assets/${importId}`;
}

/** Full Storage object path for one asset under a given import. */
export function assetObjectPath(uid: string, importId: string, reference: string): string {
  return `${assetStoragePrefix(uid, importId)}/${safeAssetFileName(reference)}`;
}

/**
 * Build a Firebase Storage download URL with a download token. The full object
 * path is `encodeURIComponent`-ed (so slashes become `%2F`, matching how the
 * Firebase SDK addresses objects via the `/o/{path}` REST endpoint).
 */
export function tokenizedUrl(bucket: string, objectPath: string, token: string): string {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encoded}?alt=media&token=${token}`;
}

/**
 * Resolves an embed reference (matched by basename) to the asset's bytes, or
 * `null` if the archive doesn't carry it. Provided by the caller (the zip /
 * GitHub archive), so this module never reads the filesystem or network.
 */
export type AssetLookup = (name: string) => Buffer | null;

/**
 * Build an `AssetLookup` from a list of `{ name, data }` archive entries, keyed
 * by normalised basename (case-insensitive). Later entries do not overwrite an
 * earlier basename, so resolution is deterministic by archive order. Callers
 * (ingestVault, githubSync) use this to turn their unzipped entries into a lookup.
 */
export function buildAssetLookup(
  entries: { name: string; data: () => Buffer }[],
): AssetLookup {
  const byBasename = new Map<string, () => Buffer>();
  for (const entry of entries) {
    const key = normaliseAssetName(entry.name);
    if (!key) continue;
    if (!byBasename.has(key)) byBasename.set(key, entry.data);
  }
  return (name: string): Buffer | null => {
    const getter = byBasename.get(normaliseAssetName(name));
    return getter ? getter() : null;
  };
}

/** Returned by `uploadVaultAssets`: basename -> tokenized download URL. */
export type AssetUrlMap = Map<string, string>;

export interface UploadVaultAssetsArgs {
  uid: string;
  importId: string;
  notes: ParsedNote[];
  lookup: AssetLookup;
}

/**
 * Upload every distinct embedded image the archive actually carries to Storage
 * and return a `Map<basename, url>`. Missing files (not in the archive) and
 * oversized files (> ~10 MB) are skipped with a warning. Token per object is a
 * `crypto.randomUUID()`, written into the object's `firebaseStorageDownloadTokens`
 * metadata so the tokenized URL resolves.
 *
 * This does NOT mutate concepts; call `attachAssetsToConcepts` after to attach.
 * Idempotent per import: re-importing writes under a fresh `importId`, so a new
 * URL set replaces the old one on the concept docs (mastery is never touched).
 */
export async function uploadVaultAssets({
  uid,
  importId,
  notes,
  lookup,
}: UploadVaultAssetsArgs): Promise<AssetUrlMap> {
  // Distinct references across all notes, keyed by normalised basename; keep the
  // first-seen spelling for logging.
  const distinct = new Map<string, string>();
  for (const note of notes) {
    for (const ref of note.imageEmbeds) {
      const key = normaliseAssetName(ref);
      if (key && !distinct.has(key)) distinct.set(key, ref);
    }
  }

  const bucket = getStorage().bucket();
  const urls: AssetUrlMap = new Map();

  for (const [basename, reference] of distinct) {
    const buffer = lookup(reference);
    if (!buffer) {
      // Embed points at an attachment the archive doesn't carry — render-time
      // fallback shows the raw text; nothing to upload.
      console.warn(`[ingest:assets] no bytes for embedded image "${reference}" — skipping`);
      continue;
    }
    if (buffer.length > MAX_ASSET_BYTES) {
      console.warn(
        `[ingest:assets] image "${reference}" is ${buffer.length} bytes (> ${MAX_ASSET_BYTES}) — skipping`,
      );
      continue;
    }

    const objectPath = assetObjectPath(uid, importId, reference);
    const token = crypto.randomUUID();
    try {
      await bucket.file(objectPath).save(buffer, {
        metadata: {
          contentType: contentTypeFor(reference),
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
    } catch (err) {
      console.warn(
        `[ingest:assets] failed to upload "${reference}" to ${objectPath}: ${(err as Error).message}`,
      );
      continue;
    }
    urls.set(basename, tokenizedUrl(bucket.name, objectPath, token));
  }

  return urls;
}

/**
 * Attach resolved asset URLs to each concept. For every note embed that resolved
 * to an uploaded URL, set `concept.assets = [{ name: <embed as written>, url }]`
 * (order-preserving, deduped by name). Concepts and notes line up by index — the
 * caller assembles concepts from the same `notes` array. Concepts with no
 * resolved embeds are left untouched (no empty `assets` array).
 */
export function attachAssetsToConcepts(
  concepts: Concept[],
  notes: ParsedNote[],
  urls: AssetUrlMap,
): void {
  const byPath = new Map(notes.map((n) => [n.sourcePath, n]));
  for (const concept of concepts) {
    const note = byPath.get(concept.sourcePath);
    if (!note || note.imageEmbeds.length === 0) continue;

    const assets: { name: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const name of note.imageEmbeds) {
      const url = urls.get(normaliseAssetName(name));
      if (!url) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      assets.push({ name, url });
    }
    if (assets.length > 0) concept.assets = assets;
  }
}
