"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * A numeric input whose stepper matches the app instead of the browser's stock
 * spin buttons (which are grey, hover-only, and unstyleable). The native
 * spinners are hidden by `.stash-number-input` in `globals.css`; keyboard
 * ArrowUp/ArrowDown on the input still work because this is still `type=number`.
 */

export type NumberFieldProps = {
  value: string;
  onChange: (value: string) => void;
  step?: number;
  min?: number;
  max?: number;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Rendered inside the field, before the value — e.g. "$". */
  prefix?: ReactNode;
  /** Wrapper classes (width, margins). */
  className?: string;
  /** Extra input classes — pass `text-right` for ledger-style alignment. */
  inputClassName?: string;
  /**
   * `sm` matches a compact `py-1.5` row control, `md` a `px-3 py-2` modal input,
   * `lg` the same box at page-form text size (matches `GlassDropdown` size `md`).
   */
  size?: "sm" | "md" | "lg";
  "aria-label"?: string;
};

const SIZE_CLASSES: Record<"sm" | "md" | "lg", string> = {
  sm: "py-1.5 text-sm",
  md: "py-2 text-sm",
  lg: "py-2 text-base",
};

/** Hold-to-repeat timings, roughly matching native spin-button feel. */
const HOLD_DELAY_MS = 400;
const HOLD_INTERVAL_MS = 70;

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

export default function NumberField({
  value,
  onChange,
  step = 1,
  min,
  max,
  id,
  placeholder,
  disabled = false,
  required = false,
  prefix,
  className = "",
  inputClassName = "",
  size = "md",
  "aria-label": ariaLabel,
}: NumberFieldProps) {
  const stepBy = useCallback(
    (direction: 1 | -1) => {
      if (disabled) return;
      const decimals = decimalsOf(step);
      const parsed = Number.parseFloat(value);
      const base = Number.isFinite(parsed) ? parsed : 0;
      let next = base + direction * step;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      // toFixed re-quantizes the float drift from repeated 0.01 additions.
      onChange(next.toFixed(decimals));
    },
    [disabled, step, value, min, max, onChange]
  );

  // Kept in a ref so the repeat timer always calls the current-value closure.
  const stepRef = useRef(stepBy);
  useEffect(() => {
    stepRef.current = stepBy;
  }, [stepBy]);

  // Held direction drives the repeat timer, so releasing the pointer anywhere —
  // including outside the button or the window — always tears it down.
  const [holdDirection, setHoldDirection] = useState<1 | -1 | null>(null);

  useEffect(() => {
    if (holdDirection === null) return;

    let repeat: ReturnType<typeof setInterval> | undefined;
    const delay = setTimeout(() => {
      repeat = setInterval(() => stepRef.current(holdDirection), HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);

    const release = () => setHoldDirection(null);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);

    return () => {
      clearTimeout(delay);
      if (repeat) clearInterval(repeat);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [holdDirection]);

  const stepperButtonClass = `
    flex flex-1 items-center justify-center text-gray-400
    hover:text-[#50C878] hover:bg-[#50C878]/10 active:bg-[#50C878]/20
    transition-colors disabled:opacity-40 disabled:pointer-events-none
  `;

  function stepperProps(direction: 1 | -1) {
    return {
      type: "button" as const,
      tabIndex: -1,
      disabled,
      // preventDefault keeps focus in the input while the value ticks.
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        stepBy(direction);
        setHoldDirection(direction);
      },
      onPointerUp: () => setHoldDirection(null),
      onPointerLeave: () => setHoldDirection(null),
      className: stepperButtonClass,
    };
  }

  return (
    <div className={`relative ${className}`}>
      {prefix !== undefined && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
          {prefix}
        </span>
      )}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        className={`
          stash-number-input w-full rounded-lg
          bg-charcoal border border-charcoal-dark text-gray-200
          placeholder:text-gray-500
          focus:border-accent focus:ring-1 focus:ring-accent outline-none
          transition-colors disabled:opacity-50
          ${SIZE_CLASSES[size]}
          ${prefix !== undefined ? "pl-7" : "pl-3"} pr-9
          ${inputClassName}
        `}
      />
      <div
        className="
          absolute right-1 top-1 bottom-1 flex w-6 flex-col overflow-hidden
          rounded-md border border-charcoal-dark bg-charcoal-light/70
        "
      >
        <button {...stepperProps(1)} aria-label="Increase value">
          <ChevronUp className="w-3 h-3" />
        </button>
        <div className="h-px bg-charcoal-dark" />
        <button {...stepperProps(-1)} aria-label="Decrease value">
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
