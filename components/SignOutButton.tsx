"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { LogOut, Loader2 } from "lucide-react";
import { purgeClientCaches } from "@/lib/clientCache";

/**
 * Signing out has to clear the browser too, not just the cookie: cached API
 * responses and per-user localStorage would otherwise still be sitting there
 * when the next person signs in on the same device.
 */
export default function SignOutButton({ collapsed = false }: { collapsed?: boolean }) {
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    await purgeClientCaches();
    await signOut({ callbackUrl: "/signin" });
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      title="Sign out"
      aria-label="Sign out"
      className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-gray-300 hover:bg-charcoal hover:text-white transition-colors disabled:opacity-50 ${
        collapsed ? "justify-center px-2" : ""
      }`}
    >
      {busy ? (
        <Loader2 className="w-5 h-5 shrink-0 animate-spin" />
      ) : (
        <LogOut className="w-5 h-5 shrink-0" />
      )}
      {!collapsed && <span>Sign out</span>}
    </button>
  );
}
