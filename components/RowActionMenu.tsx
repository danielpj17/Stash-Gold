"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, MoreVertical } from "lucide-react";

export type RowAction = {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  /** Tooltip — good place to say *why* a disabled action is unavailable. */
  title?: string;
  tone?: "default" | "positive" | "danger";
};

export type RowActionMenuProps = {
  actions: RowAction[];
  "aria-label"?: string;
  /** Swaps the trigger for a spinner while the row's action is in flight. */
  busy?: boolean;
  disabled?: boolean;
  className?: string;
};

const TONE_CLASSES: Record<NonNullable<RowAction["tone"]>, string> = {
  default: "text-white/95 hover:bg-white/5",
  positive: "text-[#50C878] hover:bg-[#50C878]/10",
  danger: "text-red-300 hover:bg-red-500/10",
};

const PANEL_WIDTH = 232;
/** Below this much room under the trigger, the panel flips above it. */
const FLIP_THRESHOLD = 180;

/**
 * Overflow menu for a transaction row. Deliberately shares the glass panel
 * treatment of `GlassDropdown` (portal + fixed position + blur) so the two read
 * as one control family; it isn't a `GlassDropdown` because there is no selected
 * value — every item is a command.
 */
export default function RowActionMenu({
  actions,
  "aria-label": ariaLabel = "More actions",
  busy = false,
  disabled = false,
  className = "",
}: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        buttonRef.current && !buttonRef.current.contains(e.target as Node) &&
        panelRef.current && !panelRef.current.contains(e.target as Node)
      ) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (!open || !buttonRef.current) return;

    function recalculate() {
      const rect = buttonRef.current!.getBoundingClientRect();
      // Right-aligned to the trigger: these menus sit at the right edge of a
      // row, so a left-aligned panel would hang off the viewport.
      const left = Math.max(
        8,
        Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8),
      );
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < FLIP_THRESHOLD && rect.top > spaceBelow;
      setPanelStyle({
        position: "fixed",
        left,
        width: PANEL_WIDTH,
        zIndex: 9999,
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(80, rect.top - 8) }
          : { top: rect.bottom + 4, maxHeight: Math.max(80, spaceBelow - 8) }),
      });
    }

    recalculate();
    window.addEventListener("scroll", recalculate, { passive: true, capture: true });
    window.addEventListener("resize", recalculate, { passive: true });
    return () => {
      window.removeEventListener("scroll", recalculate, { capture: true });
      window.removeEventListener("resize", recalculate);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled || busy}
        onClick={() => setOpen((o) => !o)}
        className={`
          p-1.5 rounded-md transition-colors
          disabled:opacity-60 disabled:pointer-events-none
          ${open ? "text-white bg-white/10" : "text-gray-400 hover:text-white hover:bg-white/10"}
        `}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <MoreVertical className="w-4 h-4" />
        )}
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <ul
          ref={panelRef}
          role="menu"
          style={panelStyle}
          className="
            overflow-y-auto scrollbar-glass
            rounded-2xl border border-white/10 bg-neutral-900/75 backdrop-blur-xl
            shadow-[0_16px_48px_rgba(0,0,0,0.45)]
            divide-y divide-white/[0.08]
          "
        >
          {actions.map((action) => (
            <li key={action.key} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={action.disabled}
                title={action.title}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
                className={`
                  w-full flex items-center gap-2.5 text-left px-4 py-3 text-sm transition-colors
                  disabled:opacity-40 disabled:pointer-events-none
                  ${TONE_CLASSES[action.tone ?? "default"]}
                `}
              >
                {action.icon && <span className="shrink-0">{action.icon}</span>}
                <span className="truncate">{action.label}</span>
              </button>
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  );
}
