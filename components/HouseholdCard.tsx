"use client";

import { useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import HouseholdPanel, { labelForMember, type HouseholdState } from "./HouseholdPanel";

/**
 * Sharing setup, collapsed by default.
 *
 * Sits under the New Expense form beside `ShortcutSetupCard`, and for the same
 * reason: it is account plumbing done once, not something you want in the way
 * of the app's hot path. It also has to live here specifically — `Sidebar` is
 * `standalone:hidden` and `BottomNav` has no room, so New Expense is the only
 * surface reachable from both the web app and the installed PWA.
 *
 * Unlike ShortcutSetupCard this one fetches on mount rather than on first
 * expand: the header text itself depends on whether the Stash is shared, and
 * one small GET is the price of the collapsed row telling the truth.
 */
export default function HouseholdCard() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<HouseholdState | null>(null);

  const other = state?.members.find((m) => !m.isYou) ?? null;
  const shared = Boolean(other);

  return (
    <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="household-panel"
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#2c2c2c] transition-colors"
      >
        <Users className="w-4 h-4 shrink-0 text-[#50C878]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-white font-medium">
            {shared ? `Shared with ${labelForMember(other!)}` : "Share with someone"}
          </span>
          <span className="block text-xs text-gray-400 truncate">
            {shared
              ? "You both use this Stash, each with your own sign-in."
              : "Give your partner their own sign-in to the same budget."}
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/*
        Mounted while collapsed so the header can name the other person, but
        `hidden` rather than unmounted so expanding doesn't refetch and lose
        whatever the user had typed.
      */}
      <div
        id="household-panel"
        className={open ? "border-t border-charcoal-dark p-4" : "hidden"}
      >
        <HouseholdPanel onChange={setState} />
      </div>
    </section>
  );
}
