/**
 * Wrapper for authenticated callable functions. Centralizes:
 *   - auth enforcement (rejects unauthenticated callers),
 *   - Zod request validation (typed, contract-shaped input),
 *   - secret binding (e.g. the Anthropic key, kept server-side).
 *
 * Every callable in this codebase goes through `authedCallable` so none can
 * accidentally skip the auth check.
 */
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import type { defineSecret } from "firebase-functions/params";
import type { ZodType } from "zod";

export { HttpsError };

/** The object returned by `defineSecret(...)`, derived from the public API. */
type SecretParam = ReturnType<typeof defineSecret>;

export interface CallableCtx {
  uid: string;
}

interface CallableOpts<Req> {
  schema?: ZodType<Req>;
  secrets?: SecretParam[];
}

export function authedCallable<Req, Res>(
  opts: CallableOpts<Req>,
  handler: (data: Req, ctx: CallableCtx) => Promise<Res>,
) {
  return onCall(
    { secrets: opts.secrets ?? [] },
    async (request: CallableRequest<unknown>): Promise<Res> => {
      const uid = request.auth?.uid;
      if (!uid) {
        throw new HttpsError("unauthenticated", "You must be signed in.");
      }
      let data: Req;
      if (opts.schema) {
        const parsed = opts.schema.safeParse(request.data);
        if (!parsed.success) {
          throw new HttpsError("invalid-argument", parsed.error.message);
        }
        data = parsed.data;
      } else {
        data = request.data as Req;
      }
      return handler(data, { uid });
    },
  );
}
