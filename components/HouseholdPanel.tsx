"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, Trash2, UserPlus } from "lucide-react";

export type HouseholdMember = {
  id: string;
  name: string | null;
  email: string | null;
  isOwner: boolean;
  isYou: boolean;
};

export type HouseholdState = {
  role: "solo" | "owner" | "member";
  members: HouseholdMember[];
  pendingInvite: { id: string; email: string; createdAt: string; expiresAt: string } | null;
};

/** Best label for a person: their name, else their address, else something. */
export function labelForMember(member: HouseholdMember): string {
  return member.name?.trim() || member.email || "Someone";
}

/**
 * The body of the sharing UI, with no chrome of its own.
 *
 * Rendered in two places — the collapsed card on New Expense (the only surface
 * reachable from the installed PWA, where the sidebar is hidden) and a modal
 * opened from the sidebar on the web. Keeping it chrome-free is what lets one
 * component serve both without a wrapper prop.
 *
 * `onChange` lets the host react to a state change; it is optional because the
 * card doesn't need it.
 */
export default function HouseholdPanel({ onChange }: { onChange?: (s: HouseholdState) => void }) {
  const [state, setState] = useState<HouseholdState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaved, setNameSaved] = useState(false);

  const apply = useCallback(
    (next: HouseholdState) => {
      setState(next);
      onChange?.(next);
      const me = next.members.find((m) => m.isYou);
      setNameDraft(me?.name ?? "");
    },
    [onChange],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/household", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed to load (${res.status})`);
      apply(data as HouseholdState);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sharing settings");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation returns the new state, so there is never a refetch race. */
  const send = useCallback(
    async (path: string, method: string, body?: unknown) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch(path, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
        return data;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleInvite = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const email = inviteEmail.trim();
      if (!email) return;
      const data = await send("/api/household", "POST", { email });
      if (data) {
        apply(data as HouseholdState);
        setInviteEmail("");
      }
    },
    [inviteEmail, send, apply],
  );

  const handleSaveName = useCallback(async () => {
    const data = await send("/api/household", "PATCH", { name: nameDraft.trim() });
    if (data) {
      apply(data as HouseholdState);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 1800);
    }
  }, [nameDraft, send, apply]);

  const handleRemove = useCallback(
    async (member: HouseholdMember) => {
      const who = labelForMember(member);
      if (
        !window.confirm(
          `Remove ${who}? They'll lose access to this Stash. Nothing they entered is deleted.`,
        )
      ) {
        return;
      }
      const data = await send("/api/household", "DELETE", { memberId: member.id });
      if (data) apply(data as HouseholdState);
    },
    [send, apply],
  );

  const handleRevoke = useCallback(
    async (inviteId: string) => {
      const data = await send("/api/household", "DELETE", { inviteId });
      if (data) apply(data as HouseholdState);
    },
    [send, apply],
  );

  const handleLeave = useCallback(async () => {
    if (
      !window.confirm(
        "Leave this shared Stash? You'll go back to an empty one of your own. Nothing is deleted.",
      )
    ) {
      return;
    }
    const data = await send("/api/household/leave", "POST");
    // The data scope changed, so every client cache is now for the wrong user.
    if (data) window.location.href = "/";
  }, [send]);

  if (loading && !state) {
    return (
      <p className="text-sm text-gray-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </p>
    );
  }

  const shared = state ? state.members.length > 1 : false;
  const other = state?.members.find((m) => !m.isYou) ?? null;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!shared && state?.role !== "member" && (
        <>
          <p className="text-xs text-gray-400">
            They sign in with their own email and see the same budget, accounts and transactions.
            Everything stays in one place — only the name on each entry differs.
          </p>

          {state?.pendingInvite ? (
            <div className="rounded-lg border border-charcoal-dark px-3 py-2.5 flex items-center gap-3 flex-wrap">
              <Mail className="w-4 h-4 text-[#50C878] shrink-0" />
              <span className="text-sm text-gray-300 min-w-0 break-all">
                {state.pendingInvite.email}
              </span>
              <span className="text-xs text-gray-500">invitation sent</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRevoke(state.pendingInvite!.id)}
                className="ml-auto text-xs text-gray-400 hover:text-red-400 transition disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          ) : (
            <form onSubmit={handleInvite} className="flex gap-2 flex-wrap">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="their@email.com"
                className="flex-1 min-w-[12rem] rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
              />
              <button
                type="submit"
                disabled={busy || !inviteEmail.trim()}
                className="shrink-0 flex items-center gap-2 rounded-md bg-[#50C878] px-3 py-2 text-sm font-semibold text-charcoal disabled:opacity-50 hover:brightness-110 transition"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                Invite
              </button>
            </form>
          )}
        </>
      )}

      {shared && (
        <>
          <ul className="space-y-1.5">
            {state?.members.map((member) => (
              <li
                key={member.id}
                className="rounded-lg border border-charcoal-dark px-3 py-2.5 flex items-center gap-3 flex-wrap"
              >
                <span className="text-sm text-white">{labelForMember(member)}</span>
                {member.isYou && <span className="text-xs text-gray-500">you</span>}
                {member.isOwner && <span className="text-xs text-gray-500">owner</span>}
                {member.email && labelForMember(member) !== member.email && (
                  <span className="text-xs text-gray-500 min-w-0 break-all">{member.email}</span>
                )}
                {state?.role === "owner" && !member.isYou && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRemove(member)}
                    aria-label={`Remove ${labelForMember(member)}`}
                    className="ml-auto text-gray-400 hover:text-red-400 transition disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>

          {state?.role === "member" && (
            <p className="text-xs text-gray-500">
              You&apos;re sharing {other ? labelForMember(other) : "someone"}&apos;s Stash.{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleLeave()}
                className="underline text-gray-400 hover:text-red-400 transition disabled:opacity-50"
              >
                Leave
              </button>
            </p>
          )}
        </>
      )}

      {/*
        Only worth asking once there is someone to tell apart from. A solo user
        has no use for a display name, and showing the field would advertise a
        feature they aren't using.
      */}
      {shared && (
        <div className="pt-1 border-t border-charcoal-dark">
          <label htmlFor="household-name" className="block text-xs text-gray-400 mt-3 mb-1.5">
            Your name — shown next to transactions you enter
          </label>
          <div className="flex gap-2 flex-wrap">
            <input
              id="household-name"
              type="text"
              value={nameDraft}
              maxLength={60}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Dan"
              className="flex-1 min-w-[10rem] rounded-md bg-[#1f1f1f] border border-charcoal-dark px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-[#50C878]"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSaveName()}
              className="shrink-0 rounded-md bg-[#353535] px-3 py-2 text-sm text-gray-200 hover:text-white hover:bg-[#404040] transition disabled:opacity-50"
            >
              {nameSaved ? "Saved" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
