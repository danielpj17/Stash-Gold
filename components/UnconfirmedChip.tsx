"use client";

import Link from "next/link";

/**
 * The "unconfirmed" marker (plan D2): this row's category is a guess no person
 * chose. It still counts in its category — the bar moves now — but every place
 * that shows the category shows this too, and it opens the categorize screen.
 */
export default function UnconfirmedChip({
  transactionId,
  label = "unconfirmed",
  className = "",
}: {
  transactionId: string | undefined;
  label?: string;
  className?: string;
}) {
  const classes = `inline-flex items-center rounded-full border border-dashed border-yellow-300/60 px-1.5 py-px text-[10px] leading-4 text-yellow-200/90 hover:bg-yellow-300/10 transition-colors whitespace-nowrap ${className}`;
  if (!transactionId) return <span className={classes}>{label}</span>;
  return (
    <Link
      href={`/categorize/${encodeURIComponent(transactionId)}`}
      onClick={(e) => e.stopPropagation()}
      title="Stash guessed this category. Tap to confirm or change it."
      className={classes}
    >
      {label}
    </Link>
  );
}
