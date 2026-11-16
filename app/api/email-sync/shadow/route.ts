import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The shadow report (plan Phase 2): what email sync WOULD have done, next to
 * what was logged by hand on the same days. A week of these agreeing is the
 * gate for switching to live.
 *
 * ?days=14 (max 60)
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;

  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get("days") ?? 14) || 14, 1), 60);

  try {
    const [shadow, manual] = await Promise.all([
      sql`
        SELECT e.id, e.received_at, e.status_reason,
               e.decision->>'wouldBe' AS would_be,
               e.decision->>'action' AS action,
               e.decision->>'transactionId' AS target_id,
               e.decision->'summary' AS summary,
               e.parsed->>'kind' AS alert_kind,
               e.decision->'transactions'->0->>'category' AS category,
               e.decision->'transactions'->0->>'reviewStatus' AS review_status,
               to_char((e.decision->'summary'->>'occurredAt')::timestamptz AT TIME ZONE u.timezone, 'YYYY-MM-DD') AS local_date
          FROM email_events e
          JOIN users u ON u.id = e.user_id
         WHERE e.user_id = ${userId} AND e.status = 'shadow'
           AND e.received_at > now() - make_interval(days => ${days})
         ORDER BY e.received_at DESC
      ` as unknown as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT t.id, t.kind, t.amount, t.category, t.description, t.account, t.source,
               to_char(t.occurred_at AT TIME ZONE u.timezone, 'YYYY-MM-DD') AS local_date
          FROM transactions t
          JOIN users u ON u.id = t.user_id
         WHERE t.user_id = ${userId}
           AND t.source IN ('manual', 'shortcut')
           AND t.kind IN ('expense', 'income')
           AND t.occurred_at > now() - make_interval(days => ${days + 1})
         ORDER BY t.occurred_at DESC
      ` as unknown as Promise<Array<Record<string, unknown>>>,
    ]);

    return NextResponse.json({
      days,
      shadow: shadow.map((r) => {
        const summary = (r.summary ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          receivedAt: r.received_at,
          localDate: r.local_date,
          wouldBe: r.would_be,
          action: r.action,
          reason: r.status_reason,
          targetId: r.target_id,
          alertKind: r.alert_kind,
          amountCents: typeof summary.amountCents === "number" ? summary.amountCents : null,
          merchantName: summary.merchantName ?? null,
          accountId: summary.accountId ?? null,
          accountName: summary.accountName ?? null,
          category: r.category,
          reviewStatus: r.review_status,
        };
      }),
      manual: manual.map((r) => ({
        id: r.id,
        kind: r.kind,
        amount: Number(r.amount),
        category: r.category,
        description: r.description,
        account: r.account,
        source: r.source,
        localDate: r.local_date,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load the shadow report" },
      { status: 502 },
    );
  }
}
