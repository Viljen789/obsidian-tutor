/**
 * GitHub vault sync — pure helpers + the thin fetch/unzip glue.
 *
 * The pure parts (owner/repo/ref parsing, archive URL building, markdown-entry
 * filtering with top-level-folder stripping and subdir scoping) are unit-tested
 * without any network (see github.test.ts). The only impure function here is
 * `downloadRepoZip`, which performs the actual fetch.
 */
import AdmZip from "adm-zip";
import { isVaultMarkdown } from "./index";

/** Owner / repo extracted from a GitHub URL. */
export interface RepoCoords {
  owner: string;
  repo: string;
  /** Ref embedded in a /tree/<ref> URL, if present. */
  ref?: string;
}

/** A vault markdown file recovered from the archive: path relative to the
 *  vault root, plus its UTF-8 contents. */
export interface RepoMarkdownEntry {
  /** Path relative to the vault root (top-level archive folder already
   *  stripped; subdir stripped when one was requested). */
  path: string;
  content: string;
}

/**
 * Parse a GitHub repo URL into `{ owner, repo, ref? }`.
 *
 * Accepts:
 *   - https://github.com/owner/repo
 *   - http(s)://www.github.com/owner/repo
 *   - github.com/owner/repo            (scheme optional)
 *   - …/owner/repo.git                 (trailing .git stripped)
 *   - …/owner/repo/tree/<ref>          (ref captured; ref may contain slashes)
 *   - trailing slashes, ?query and #hash are ignored
 *
 * Throws on a non-GitHub host or a URL missing owner/repo.
 */
export function parseRepoUrl(repoUrl: string): RepoCoords {
  if (!repoUrl || typeof repoUrl !== "string") {
    throw new Error("A GitHub repository URL is required.");
  }

  const trimmed = repoUrl.trim();
  // Allow a scheme-less "github.com/owner/repo" by defaulting to https.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${repoUrl}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") {
    throw new Error(
      `Only github.com URLs are supported (got "${parsed.hostname}").`,
    );
  }

  // Path segments, dropping empties from leading/trailing/double slashes.
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      `URL must point at a repo, e.g. https://github.com/owner/repo (got "${repoUrl}").`,
    );
  }

  const owner = segments[0];
  let repo = segments[1];
  if (!owner || !repo) {
    throw new Error(
      `URL must include both an owner and a repo (got "${repoUrl}").`,
    );
  }
  // Strip a trailing ".git".
  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }
  if (!repo) {
    throw new Error(`URL must include a repo name (got "${repoUrl}").`);
  }

  // A /tree/<ref...> suffix carries the branch/tag (refs can contain slashes,
  // e.g. feature/foo). Everything after "tree" joins back into the ref.
  let ref: string | undefined;
  if (segments[2] === "tree" && segments.length >= 4) {
    ref = segments.slice(3).join("/");
  }

  return { owner, repo, ...(ref ? { ref } : {}) };
}

/**
 * Public (token-less) archive URL via codeload. We treat `ref` as a branch
 * name here; the caller falls back across candidate branches (main/master) on
 * 404.
 */
export function publicZipUrl(
  owner: string,
  repo: string,
  branch: string,
): string {
  return `https://codeload.github.com/${encodeURIComponent(
    owner,
  )}/${encodeURIComponent(repo)}/zip/refs/heads/${encodeURIComponentRef(branch)}`;
}

/**
 * Private archive URL via the GitHub API zipball. `ref` is optional — omitting
 * it lets GitHub pick the default branch.
 */
export function privateZipUrl(
  owner: string,
  repo: string,
  ref?: string,
): string {
  const base = `https://api.github.com/repos/${encodeURIComponent(
    owner,
  )}/${encodeURIComponent(repo)}/zipball`;
  return ref ? `${base}/${encodeURIComponentRef(ref)}` : base;
}

/** Branch candidates to try when no explicit ref is supplied (public path). */
export const DEFAULT_BRANCH_CANDIDATES = ["main", "master"] as const;

/**
 * Strip the archive's top-level wrapper folder from an entry name.
 *
 * GitHub zip archives wrap everything in a single `{repo}-{ref}/` (or
 * `{owner}-{repo}-{sha}/` for API zipballs) directory. We don't care what it's
 * called — we just drop the first path segment. Returns "" for the wrapper
 * directory entry itself.
 */
export function stripTopLevelDir(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  return slash === -1 ? "" : normalized.slice(slash + 1);
}

/** Normalize a user-supplied subdir to a clean, slash-bounded prefix, or "". */
function normalizeSubdir(subdir?: string): string {
  if (!subdir) return "";
  const cleaned = subdir
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
  return cleaned;
}

/**
 * Turn raw archive entries into vault markdown entries, in pipeline-ready form.
 *
 * For each entry: strip the top-level wrapper folder, optionally scope to
 * `subdir` (treating it as the vault root — its prefix is removed from the
 * returned path), and keep only vault markdown (`.md`, no dotfiles/dotfolders)
 * per the shared `isVaultMarkdown` rule.
 *
 * `entries` is a minimal shape so tests can pass plain objects (no adm-zip).
 */
export function collectMarkdownEntries(
  entries: { entryName: string; isDirectory: boolean; content: string }[],
  subdir?: string,
): RepoMarkdownEntry[] {
  const prefix = normalizeSubdir(subdir);
  const prefixSlash = prefix ? `${prefix}/` : "";

  const out: RepoMarkdownEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const afterTop = stripTopLevelDir(entry.entryName);
    if (!afterTop) continue;

    // Scope to the subdir, treating it as the vault root.
    let relative = afterTop;
    if (prefixSlash) {
      if (!afterTop.startsWith(prefixSlash)) continue;
      relative = afterTop.slice(prefixSlash.length);
      if (!relative) continue;
    }

    if (!isVaultMarkdown(relative)) continue;
    out.push({ path: relative, content: entry.content });
  }
  return out;
}

// --- Impure: the actual download ------------------------------------------

/** Headers GitHub requires for API zipball requests (private repos). */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "obsidian-tutor",
  };
}

/** Thrown by `downloadRepoZip` so the flow can map status → HttpsError. */
export class GitHubFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubFetchError";
  }
}

/**
 * Download the repo archive and return its entries as plain objects (decoded to
 * UTF-8), ready for `collectMarkdownEntries`.
 *
 * Private path (token given): GitHub API zipball with auth headers, honoring
 * the supplied (or default) ref.
 * Public path (no token): codeload by branch. If no ref was supplied, tries the
 * default-branch candidates (main, then master) in order.
 *
 * The token is only ever used as a request header — never logged.
 */
export async function downloadRepoZip(
  coords: RepoCoords,
  opts: { ref?: string; token?: string },
): Promise<
  { entryName: string; isDirectory: boolean; content: string; data: Buffer }[]
> {
  const { owner, repo } = coords;
  const ref = opts.ref ?? coords.ref;
  const token = opts.token;

  let buffer: Buffer;
  if (token) {
    // Private (or any) repo via the authenticated API zipball.
    const url = privateZipUrl(owner, repo, ref);
    buffer = await fetchZipBuffer(url, apiHeaders(token));
  } else if (ref) {
    // Public repo, explicit branch.
    buffer = await fetchZipBuffer(publicZipUrl(owner, repo, ref), {});
  } else {
    // Public repo, default branch unknown — try the common candidates.
    buffer = await fetchDefaultBranchZip(owner, repo);
  }

  // `content` is the UTF-8 text used for markdown notes; `data` is the raw bytes,
  // needed for binary attachments (images) where UTF-8 decoding would be lossy.
  return new AdmZip(buffer).getEntries().map((e) => {
    const data = e.isDirectory ? Buffer.alloc(0) : e.getData();
    return {
      entryName: e.entryName,
      isDirectory: e.isDirectory,
      content: e.isDirectory ? "" : data.toString("utf8"),
      data,
    };
  });
}

/** Fetch a URL and return the body as a Buffer, mapping HTTP errors. */
async function fetchZipBuffer(
  url: string,
  headers: Record<string, string>,
): Promise<Buffer> {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new GitHubFetchError(
      `GitHub responded ${res.status} for ${url}`,
      res.status,
    );
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/** Try each default-branch candidate in turn; surface the last 404 if none hit. */
async function fetchDefaultBranchZip(
  owner: string,
  repo: string,
): Promise<Buffer> {
  let lastErr: GitHubFetchError | undefined;
  for (const branch of DEFAULT_BRANCH_CANDIDATES) {
    try {
      return await fetchZipBuffer(publicZipUrl(owner, repo, branch), {});
    } catch (err) {
      if (err instanceof GitHubFetchError && err.status === 404) {
        lastErr = err;
        continue; // branch doesn't exist — try the next candidate.
      }
      throw err;
    }
  }
  throw (
    lastErr ??
    new GitHubFetchError(
      `No default branch (${DEFAULT_BRANCH_CANDIDATES.join("/")}) found for ${owner}/${repo}`,
      404,
    )
  );
}

/**
 * Encode a ref for a URL path while keeping the slashes that separate path
 * segments (e.g. a `feature/foo` branch). encodeURIComponent would turn "/"
 * into "%2F", which codeload/the API reject.
 */
function encodeURIComponentRef(ref: string): string {
  return ref
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
