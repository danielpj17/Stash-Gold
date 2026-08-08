"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Replacement for `<input type="date">`. The browser's own picker can't be
 * themed (the popup and its calendar glyph are chrome, not DOM), so it always
 * looked pasted-in against the charcoal/green UI. This renders the same glass
 * panel as `GlassDropdown` and speaks the same value format — "YYYY-MM-DD",
 * empty string for no date — so callers swap one for the other in place.
 */

export type DateFieldProps = {
  /** "YYYY-MM-DD", or "" for empty. */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Shows a "Clear" action in the panel footer. */
  clearable?: boolean;
  /** `sm` matches a `px-2.5 py-1.5` control; `md` a `px-3 py-2` text input. */
  size?: "sm" | "md";
  "aria-label"?: string;
};

const SIZE_CLASSES: Record<"sm" | "md", string> = {
  sm: "px-2.5 py-1.5 text-sm",
  md: "px-3 py-2 text-sm",
};

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Panel is measured to decide whether it opens downward or flips above. */
const PANEL_MIN_WIDTH = 268;
const PANEL_HEIGHT_ESTIMATE = 348;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toISO(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parses local-time. `new Date("2026-08-07")` is parsed as UTC and lands on the
 * 6th in western timezones, which would silently shift every date the user picks.
 */
function parseISO(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  const valid =
    date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
  return valid ? date : null;
}

function formatDisplay(date: Date): string {
  return `${DAYS_SHORT[date.getDay()]}, ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** Six weeks starting on the Sunday on or before the 1st — a stable 42-cell grid. */
function buildCalendarGrid(viewMonth: Date): Date[] {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export default function DateField({
  value,
  onChange,
  id,
  className = "",
  placeholder = "Select date",
  disabled = false,
  clearable = true,
  size = "md",
  "aria-label": ariaLabel,
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const [pickingMonth, setPickingMonth] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const [focusedDate, setFocusedDate] = useState<Date>(() => parseISO(value) ?? new Date());
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const selected = parseISO(value) ?? new Date();
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selectedDate = useMemo(() => parseISO(value), [value]);
  const today = useMemo(() => new Date(), []);
  const grid = useMemo(() => buildCalendarGrid(viewMonth), [viewMonth]);

  const closePanel = useCallback((returnFocus = true) => {
    setOpen(false);
    setPickingMonth(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  /** Reopening always lands on the selected date, not wherever the user browsed to. */
  const openPanel = useCallback(() => {
    const anchor = parseISO(value) ?? new Date();
    setFocusedDate(anchor);
    setViewMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    setPickingMonth(false);
    setOpen(true);
  }, [value]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
      setPickingMonth(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || !triggerRef.current) return;

    function recalculate() {
      const rect = triggerRef.current!.getBoundingClientRect();
      const width = Math.min(
        Math.max(rect.width, PANEL_MIN_WIDTH),
        Math.max(PANEL_MIN_WIDTH, window.innerWidth - 16)
      );
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < PANEL_HEIGHT_ESTIMATE + 12 && rect.top > spaceBelow;

      setPanelStyle({
        position: "fixed",
        left,
        width,
        zIndex: 9999,
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
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

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const commit = useCallback(
    (date: Date) => {
      onChange(toISO(date));
      closePanel();
    },
    [onChange, closePanel]
  );

  const moveFocus = useCallback((next: Date) => {
    setFocusedDate(next);
    setViewMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  }, []);

  function handlePanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
      return;
    }
    if (pickingMonth) return;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(addDays(focusedDate, -1));
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(addDays(focusedDate, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(addDays(focusedDate, -7));
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(addDays(focusedDate, 7));
        break;
      case "PageUp":
        e.preventDefault();
        moveFocus(addDays(focusedDate, -28));
        break;
      case "PageDown":
        e.preventDefault();
        moveFocus(addDays(focusedDate, 28));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(focusedDate);
        break;
      default:
        break;
    }
  }

  const navButtonClass =
    "p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors";

  const panel = (
    <div
      ref={panelRef}
      style={panelStyle}
      tabIndex={-1}
      role="dialog"
      aria-label={ariaLabel ? `${ariaLabel} calendar` : "Choose date"}
      onKeyDown={handlePanelKeyDown}
      className="
        rounded-2xl border border-white/10 bg-neutral-900/85 backdrop-blur-xl
        shadow-[0_16px_48px_rgba(0,0,0,0.55)] p-3 outline-none
      "
    >
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={() =>
            pickingMonth
              ? setViewMonth(addMonths(viewMonth, -12))
              : setViewMonth(addMonths(viewMonth, -1))
          }
          className={navButtonClass}
          aria-label={pickingMonth ? "Previous year" : "Previous month"}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setPickingMonth((p) => !p)}
          className="
            flex-1 px-2 py-1 rounded-lg text-sm font-medium text-white
            hover:bg-white/10 transition-colors
          "
          aria-label="Switch between month and day view"
        >
          {pickingMonth
            ? viewMonth.getFullYear()
            : `${MONTHS[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`}
        </button>
        <button
          type="button"
          onClick={() =>
            pickingMonth
              ? setViewMonth(addMonths(viewMonth, 12))
              : setViewMonth(addMonths(viewMonth, 1))
          }
          className={navButtonClass}
          aria-label={pickingMonth ? "Next year" : "Next month"}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {pickingMonth ? (
        <div className="grid grid-cols-3 gap-1.5 mt-3">
          {MONTHS_SHORT.map((month, index) => {
            const isCurrentView = index === viewMonth.getMonth();
            return (
              <button
                key={month}
                type="button"
                onClick={() => {
                  setViewMonth(new Date(viewMonth.getFullYear(), index, 1));
                  setPickingMonth(false);
                }}
                className={`
                  py-2 rounded-lg text-sm transition-colors
                  ${isCurrentView
                    ? "bg-[#50C878]/15 text-[#50C878] font-medium"
                    : "text-white/85 hover:bg-white/10"}
                `}
              >
                {month}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 mt-3 mb-1">
            {WEEKDAYS.map((day, index) => (
              <span
                key={`${day}-${index}`}
                className="text-center text-[11px] font-medium uppercase tracking-wide text-gray-500 py-1"
              >
                {day}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((day) => {
              const inMonth = day.getMonth() === viewMonth.getMonth();
              const isSelected = selectedDate ? isSameDay(day, selectedDate) : false;
              const isToday = isSameDay(day, today);
              const isFocused = isSameDay(day, focusedDate);

              let tone = inMonth ? "text-white/90 hover:bg-white/10" : "text-white/25 hover:bg-white/5";
              if (isToday && !isSelected) {
                tone = "text-[#50C878] font-semibold ring-1 ring-inset ring-[#50C878]/40 hover:bg-[#50C878]/10";
              }
              if (isSelected) {
                tone = "bg-accent text-charcoal font-semibold shadow-[0_4px_14px_rgba(80,200,120,0.35)]";
              }

              return (
                <button
                  key={day.getTime()}
                  type="button"
                  tabIndex={-1}
                  onClick={() => commit(day)}
                  onMouseEnter={() => setFocusedDate(day)}
                  aria-current={isSelected ? "date" : undefined}
                  aria-label={formatDisplay(day)}
                  className={`
                    h-9 rounded-lg text-sm transition-colors
                    ${tone}
                    ${isFocused && !isSelected ? "bg-white/10" : ""}
                  `}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/10">
        <button
          type="button"
          onClick={() => commit(new Date())}
          className="px-2 py-1 rounded-md text-xs font-medium text-[#50C878] hover:bg-[#50C878]/10 transition-colors"
        >
          Today
        </button>
        {clearable && value && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              closePanel();
            }}
            className="px-2 py-1 rounded-md text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className={`relative ${className}`}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closePanel(false) : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`
          w-full flex items-center gap-2 justify-between min-w-0
          ${SIZE_CLASSES[size]} rounded-lg
          bg-charcoal/95 border text-left transition-colors
          ${open ? "border-accent ring-1 ring-accent" : "border-charcoal-dark hover:border-[#50C878]/40"}
          focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
          disabled:opacity-50 disabled:pointer-events-none
        `}
      >
        <span className={`truncate ${selectedDate ? "text-gray-200" : "text-gray-500"}`}>
          {selectedDate ? formatDisplay(selectedDate) : placeholder}
        </span>
        <CalendarDays
          className={`w-4 h-4 shrink-0 transition-colors ${open ? "text-accent" : "text-gray-400"}`}
          aria-hidden
        />
      </button>

      {open && typeof document !== "undefined" && createPortal(panel, document.body)}
    </div>
  );
}
