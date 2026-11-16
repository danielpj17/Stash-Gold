import { NextRequest, NextResponse } from "next/server";
import { isErrorResponse, requireUser } from "@/lib/apiAuth";
import { applyPlan, finishEvent } from "@/lib/email/apply";
import type { Plan } from "@/lib/email/decide";
import { merchantKey } from "@/lib/email/merchantKey";
import { processEvent } from "@/lib/email/pipeline";
import type { ParsedAlert } from "@/lib/email/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Which purchase did this update?" — an `ambiguous` follow-up (a posted or
 * amount-changed alert that matched more than one pending purchase).
 *
 * Body: { transactionId } applies it to that purchase; { dismiss: true }
 * records it ignored (e.g. the purchases were already right).
 */
export async function POST(request: NextRequest, context: { params: { id: string } }) {
  const ctx = await requireUser();
  if (isErrorResponse(ctx)) return ctx;
  const { sql, userId } = ctx;
  const eventId = String(context.params.id ?? "").trim();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const rows = (await sql`
      SELECT id, status, parsed, decision, parser_id, parser_version
        FROM email_events
       WHERE user_id = ${userId} AND id = ${eventId}::uuid
    `) as Array<{
      id: string;
      status: string;
      parsed: ParsedAlert | null;
      decision: { candidateIds?: string[]; summary?: { occurredAt?: string } } | null;
      parser_id: string;
      parser_version: number;
    }>;
    const ev = rows[0];
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (ev.status !== "ambiguous") {
      return NextResponse.json({ error: "This alert was already resolved.", status: ev.status }, { status: 409 });
    }

    if (body.dismiss === true) {
      await finishEvent(sql, userId, eventId, {
        status: "ignored",
        reason: "ambiguous_dismissed",
        parserId: ev.parser_id,
        parserVersion: ev.parser_version,
        parsed: ev.parsed,
        decision: ev.decision,
      });
      return NextResponse.json({ status: "ignored" });
    }

    if (body.reprocess === true) {
      // e.g. one of the candidates was deleted — let the rules decide again.
      await sql`UPDATE email_events SET status = 'received' WHERE user_id = ${userId} AND id = ${eventId}::uuid`;
      return NextResponse.json(await processEvent(sql, userId, eventId));
    }

    const transactionId = typeof body.transactionId === "string" ? body.transactionId : "";
    const candidates = ev.decision?.candidateIds ?? [];
    if (!transactionId || !candidates.includes(transactionId) || !ev.parsed) {
      return NextResponse.json({ error: "Pick one of the listed purchases" }, { status: 400 });
    }

    const tx = (await sql`
      SELECT amount FROM transactions WHERE user_id = ${userId} AND id = ${transactionId}
    `) as Array<{ amount: string }>;
    if (!tx[0]) return NextResponse.json({ error: "That purchase no longer exists" }, { status: 404 });

    const oldCents = Math.round(Number(tx[0].amount) * 100);
    const plan: Plan = {
      action: "followup",
      status: "followup",
      reason: "resolved_by_person",
      transactionId,
      oldAmountCents: oldCents,
      newAmountCents: ev.parsed.amountCents,
      changeReason: "posted",
      autoMerged: false,
      isPending: false,
    };
    await applyPlan(sql, {
      userId,
      eventId,
      occurredAt: ev.decision?.summary?.occurredAt ?? new Date().toISOString(),
      merchantKey: merchantKey(ev.parsed.merchantRaw),
      merchantRaw: ev.parsed.merchantRaw,
      merchant: null,
      plan,
      parserId: ev.parser_id,
      parserVersion: ev.parser_version,
      parsed: ev.parsed,
      decisionExtra: { candidateIds: candidates, summary: ev.decision?.summary },
    });
    return NextResponse.json({ status: "followup", transactionId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to resolve" },
      { status: 502 },
    );
  }
}
