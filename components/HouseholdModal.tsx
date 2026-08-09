"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import HouseholdPanel from "./HouseholdPanel";

/**
 * The sidebar's way into sharing, opened from the account email.
 *
 * Same body as `HouseholdCard`, different chrome — the web has a sidebar to
 * hang this off, the installed PWA doesn't, so the collapsed card on New
 * Expense stays the primary route and this is the convenience one.
 */
export default function HouseholdModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Sharing"
      >
        <div className="px-5 py-3.5 bg-[#353535] border-b border-charcoal-dark flex items-center gap-3">
          <h2 className="text-white font-semibold flex-1">Sharing</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 max-h-[70vh] overflow-y-auto scrollbar-thin">
          <HouseholdPanel />
        </div>
      </div>
    </div>
  );
}
