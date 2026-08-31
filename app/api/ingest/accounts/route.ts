import { NextRequest, NextResponse } from "next/server";
import { listAccounts } from "@/lib/accounts";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The account list, for the iOS Shortcut's picker.
 *
 * Deliberately separate from `/api/accounts` rather than teaching that route
 * to accept a bearer token. Two reasons:
 *
 *   1. `/api/accounts` returns opening balances and CSV parsing profiles —
 *      more than a transaction-logging token has any business reading.
 *   2. That file also hosts a session-only POST. Keeping every bearer-reachable
 *      surface under `app/api/ingest/` means "what can a stolen token do?" is
 *      answered by listing one directory.
 *
 * Token-only, matching the ingest POST: a stolen session cookie can't reach it.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser(request, { allowBearer: true });
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId, via } = ctx;

  if (via !== "token") {
    return NextResponse.json(
      { error: "Send an ingest token: Authorization: Bearer stsh_…" },
      { status: 401 },
    );
  }

  try {
    // userId, not actorId. Accounts are household data — scoping this on the
    // person would show each spouse's Shortcut a different (empty) list.
    const live = (await listAccounts(sql, userId)).filter((a) => !a.isDeleted && a.isActive);

    /**
     * Shaped for Shortcuts, not for tidiness.
     *
     * `Choose from List` renders a list of dictionaries as unreadable raw text,
     * and recovering the chosen row's sibling field needs two `Repeat with
     * Each` loops. A plain string array plus a name→id lookup turns the whole
     * picker into four linear actions.
     *
     * Keying `ids` by name is safe *because* live account names are unique —
     * that's a partial unique index over non-deleted rows, not a coincidence.
     * `names` is sent as its own array rather than leaning on the dictionary's
     * `All Keys`, so the picker's order is pinned to the app's `sort_order`.
     */
    return NextResponse.json({
      names: live.map((a) => a.name),
      ids: Object.fromEntries(live.map((a) => [a.name, a.id])),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load accounts" },
      { status: 502 },
    );
  }
}
