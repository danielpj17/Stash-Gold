/**
 * Browser-safe flow-direction helper.
 *
 * Lives outside services/reconciliationService.ts — which re-exports it — because
 * that module imports node:crypto and webpack cannot bundle it for the client.
 * The CSV mapping modal needs this to colour its preview, and that is a client
 * component.
 */

/**
 * Which way money moved, normalized across the two CSV sign conventions.
 * `-1` = money left this account, `+1` = money entered it.
 *
 * **A raw sign means nothing across accounts.** A checking export writes an
 * outflow as negative; a credit-card export with debit/credit columns writes a
 * *payment received* as negative too (the credit column parses negative, and
 * `outflow_is_positive` says a charge is the positive one). So paying a card
 * from checking produces two NEGATIVE legs for what is obviously one transfer
 * out of one account and into another — and a card purchase parses POSITIVE,
 * which a naive `amount < 0` test reads as income.
 *
 * Anything comparing two legs of a transfer, or deciding whether a line cost the
 * user money, must use this rather than the sign. The parsed sign itself is
 * never normalized — that would change hashes and orphan every claim keyed to
 * them.
 */
export function normalizedFlowDirection(amount: number, outflowIsPositive: boolean): 1 | -1 {
  const raw: 1 | -1 = amount < 0 ? -1 : 1;
  if (!outflowIsPositive) return raw;
  return raw === 1 ? -1 : 1;
}
