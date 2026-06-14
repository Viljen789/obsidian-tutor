/**
 * Resolve image-embed references in vault markdown to the concrete asset URLs
 * carried on an ingested concept (`Concept.assets`).
 *
 * Obsidian and standard markdown reference the same image in several shapes:
 *   - `![[er-diagram.png]]`            (vault embed, bare name)
 *   - `![[Folder/er-diagram.png]]`     (vault embed, vault-relative path)
 *   - `![](./img/er-diagram.png)`      (standard image, relative path)
 *
 * Assets, meanwhile, are stored under a single `name` (typically the upload's
 * basename). To make every reference shape resolve to the same asset, we match
 * purely on the BASENAME — the final path segment — case-insensitively.
 */

/**
 * The final path segment of an embed reference, with any `../`, `./` and folder
 * prefixes stripped. Handles both `/` and `\` separators and trims whitespace
 * so `  Folder/Sub\er-diagram.png ` -> `er-diagram.png`.
 */
function basename(ref: string): string {
  const trimmed = ref.trim();
  // Split on either separator; the last non-empty segment is the file name.
  const segments = trimmed.split(/[/\\]/);
  return (segments[segments.length - 1] ?? trimmed).trim();
}

/**
 * Build a pure resolver that maps an embed reference (bare name or any path) to
 * the matching asset URL, or `null` when no asset matches.
 *
 * Matching is by basename, case-insensitive. The lookup is built once from the
 * `assets` array; on collision (two assets sharing a basename) the first wins,
 * which keeps the function deterministic.
 *
 * Returns a resolver that always yields `null` when `assets` is missing/empty,
 * so callers can treat "no assets" and "no match" identically.
 */
export function buildAssetResolver(
  assets?: { name: string; url: string }[],
): (name: string) => string | null {
  const byBasename = new Map<string, string>();
  for (const asset of assets ?? []) {
    const key = basename(asset.name).toLowerCase();
    if (key && !byBasename.has(key)) {
      byBasename.set(key, asset.url);
    }
  }

  return (name: string): string | null => {
    const key = basename(name).toLowerCase();
    if (!key) return null;
    return byBasename.get(key) ?? null;
  };
}
