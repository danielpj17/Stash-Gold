"use client";

import { useState } from "react";
import type { FinancialAccount } from "@/lib/accounts";
import { parserOptions } from "@/lib/email/registry";

/**
 * Email-sync routing for one account (plan §5.4, §5.9), shown inside Manage
 * Accounts. Which reader's alerts land here, and how they're told apart: the
 * card's last four, or — for Venmo, which has no card number — whose inbox
 * forwards them.
 *
 * Changing these touches no reconciliation state; they only decide where
 * future alerts go.
 */
export default function AccountAlertFields({
  account,
  disabled,
  onPatch,
}: {
  account: FinancialAccount;
  disabled: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const options = parserOptions();
  const [source, setSource] = useState(account.alertSource ?? "");
  const parser = options.find((o) => o.id === source) ?? null;
  const knownSource = !source || parser !== null;

  const field = "rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1.5 text-sm text-white focus:outline-none focus:border-[#50C878]";

  return (
    <div className="w-full flex flex-wrap items-end gap-2 pl-7 pt-1 text-xs">
      <label>
        <span className="block text-gray-500 mb-1">Email alerts from</span>
        <select
          value={source}
          disabled={disabled}
          onChange={(e) => {
            setSource(e.target.value);
            onPatch({ alertSource: e.target.value || null, ...(e.target.value ? {} : { alertLast4: null, alertForwardedFrom: null }) });
          }}
          className={field}
        >
          <option value="">None</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {!knownSource && <option value={source}>{source}</option>}
        </select>
      </label>

      {parser?.accountKey === "last4" && (
        <label>
          <span className="block text-gray-500 mb-1">Card last 4</span>
          <input
            defaultValue={account.alertLast4 ?? ""}
            inputMode="numeric"
            maxLength={4}
            disabled={disabled}
            placeholder="1234"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (account.alertLast4 ?? "")) onPatch({ alertLast4: v || null });
            }}
            className={`${field} w-[5rem]`}
          />
        </label>
      )}

      {parser?.accountKey === "forwarded_from" && (
        <label className="min-w-[14rem] flex-1">
          <span className="block text-gray-500 mb-1">Forwarded from (whose inbox)</span>
          <input
            type="email"
            defaultValue={account.alertForwardedFrom ?? ""}
            disabled={disabled}
            placeholder="you@gmail.com"
            onBlur={(e) => {
              const v = e.target.value.trim().toLowerCase();
              if (v !== (account.alertForwardedFrom ?? "")) onPatch({ alertForwardedFrom: v || null });
            }}
            className={`${field} w-full`}
          />
        </label>
      )}

      {source && (
        <label>
          <span className="block text-gray-500 mb-1">If nobody answers</span>
          <select
            value={account.unattendedAction}
            disabled={disabled}
            onChange={(e) => onPatch({ unattendedAction: e.target.value })}
            className={field}
          >
            <option value="keep_in_review">Keep waiting</option>
            <option value="auto_guess">File as the guess</option>
          </select>
        </label>
      )}
    </div>
  );
}
