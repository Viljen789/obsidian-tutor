/**
 * syncGitHub flow.
 *
 * Re-pull an Obsidian vault straight from its GitHub repo and re-ingest it,
 * instead of zipping + uploading. Reuses the SAME idempotent ingest pipeline
 * ingestVault uses (parseNote → assembleGraphWithWarnings →
 * refinePrerequisitesWithLlm/inferPrerequisites → upsertConcepts; mastery is
 * never touched) via the shared `ingestParsedNotes` helper.
 *
 * Public repos (no token) download from codeload by branch; private repos pass
 * a GitHub PAT and use the authenticated API zipball. The token is only ever
 * used as a request header — never logged.
 */
import type { SyncGitHubRequest, SyncGitHubResponse } from "@tutor/shared";
import { authedCallable, HttpsError } from "../lib/callable";
import { llmSecrets } from "../lib/llm";
import { ingestParsedNotes, parseNote } from "../ingest/index";
import { buildAssetLookup, imageExtensions } from "../ingest/assets";
import {
  parseRepoUrl,
  downloadRepoZip,
  collectMarkdownEntries,
  stripTopLevelDir,
  GitHubFetchError,
} from "../ingest/github";

/** Lowercased extension of an archive entry name, or "" if none. */
function entryExtension(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

export const syncGitHub = authedCallable<SyncGitHubRequest, SyncGitHubResponse>(
  { secrets: llmSecrets },
  async (data, { uid }): Promise<SyncGitHubResponse> => {
    const { repoUrl, ref, token, subdir } = data ?? ({} as SyncGitHubRequest);

    // 1. Validate + parse the repo URL → { owner, repo, ref? }.
    let coords;
    try {
      coords = parseRepoUrl(repoUrl);
    } catch (err) {
      throw new HttpsError("invalid-argument", (err as Error).message);
    }

    const effectiveRef = (ref && ref.trim()) || coords.ref;
    const cleanToken = token && token.trim() ? token.trim() : undefined;

    // 2. Download the repo archive (public codeload or private API zipball).
    let entries;
    try {
      entries = await downloadRepoZip(coords, {
        ref: effectiveRef,
        token: cleanToken,
      });
    } catch (err) {
      throw toHttpsError(err, coords, effectiveRef, Boolean(cleanToken));
    }

    // 3. Strip the archive's top-level wrapper folder, scope to `subdir` (if
    //    any), and keep only vault markdown — mirroring isVaultMarkdown.
    const markdown = collectMarkdownEntries(entries, subdir);

    if (markdown.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        `No markdown notes found in ${coords.owner}/${coords.repo}${
          subdir ? ` under "${subdir}"` : ""
        }.`,
      );
    }

    // 4. Build an image lookup from the archive's binary entries (basename-keyed,
    //    case-insensitive), so embedded images resolve to bytes. The top-level
    //    wrapper folder is stripped to mirror the markdown path handling; matching
    //    is by basename so subdir scoping isn't required for correctness.
    const imageExts = new Set<string>(imageExtensions);
    const lookup = buildAssetLookup(
      entries
        .filter((e) => !e.isDirectory && imageExts.has(entryExtension(e.entryName)))
        .map((e) => ({
          name: stripTopLevelDir(e.entryName) || e.entryName,
          data: () => e.data,
        })),
    );

    // 5. Parse each note, then run the SHARED ingest pipeline (with assets).
    const notes = markdown.map((m) => parseNote(m.path, m.content));
    return ingestParsedNotes(uid, notes, lookup);
  },
);

/** Map a GitHub download failure to a friendly HttpsError. Never echoes the token. */
function toHttpsError(
  err: unknown,
  coords: { owner: string; repo: string },
  ref: string | undefined,
  isPrivate: boolean,
): HttpsError {
  const where = `${coords.owner}/${coords.repo}`;
  if (err instanceof GitHubFetchError) {
    if (err.status === 404) {
      return new HttpsError(
        "not-found",
        `Repo or branch not found: ${where}${ref ? ` @ ${ref}` : ""}. ` +
          (isPrivate
            ? "Check the repo path and that your token can read it."
            : "Public repos need a valid branch (try specifying one)."),
      );
    }
    if (err.status === 401 || err.status === 403) {
      return new HttpsError(
        "permission-denied",
        `GitHub refused access to ${where}. Check that your token is valid and has read access to this repository.`,
      );
    }
    return new HttpsError(
      "unavailable",
      `GitHub request failed (status ${err.status}) for ${where}. Please try again.`,
    );
  }
  return new HttpsError(
    "unknown",
    `Could not fetch ${where} from GitHub: ${(err as Error).message}`,
  );
}
