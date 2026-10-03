import type { KeyboardEvent, MouseEvent } from "react";

/**
 * Shared modal behavior: backdrop dismissal that survives text selection, and
 * Enter-to-advance / Enter-to-save inside a modal panel.
 */

/**
 * Props for a modal's backdrop element: dismiss on a click that both started
 * and ended on the backdrop itself.
 *
 * A plain `onClick` on the backdrop is not enough. Dragging to select text in
 * an input and releasing outside the panel fires `click` on the nearest common
 * ancestor of the press and release targets — the backdrop — so the panel's
 * `stopPropagation` never sees it and the modal closed mid-edit. Recording
 * where the press began is what tells a selection drag from a real click.
 */
export function backdropDismissProps(onDismiss: () => void) {
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.dataset.backdropPress = e.target === e.currentTarget ? "1" : "";
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const pressedHere = e.currentTarget.dataset.backdropPress === "1";
      delete e.currentTarget.dataset.backdropPress;
      if (pressedHere && e.target === e.currentTarget) onDismiss();
    },
  };
}

/**
 * Fields Enter moves between. Search boxes are excluded on both ends: Enter in
 * a filter box submitting the modal would be a surprise, and tabbing into one
 * would skip past the field the user actually means next.
 */
const ENTER_FIELD_SELECTOR = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])' +
    ':not([type="reset"]):not([type="file"]):not([type="hidden"]):not([type="range"])' +
    ':not([type="color"]):not([type="search"]):not([data-enter-ignore])',
  "textarea:not([data-enter-ignore])",
].join(",");

/**
 * `onKeyDown` for a modal panel. Enter in a text field moves focus to the next
 * text field in the panel; in the last one it clicks the panel's
 * `[data-modal-submit]` button, which saves and closes like clicking Save.
 *
 * - Shift+Enter in a textarea still inserts a newline.
 * - Inputs inside a `<form>` are left alone so native form submission works.
 * - A panel with no `[data-modal-submit]` (destructive confirmations) only
 *   advances; Enter in its last field does nothing.
 */
export function handleModalEnterKey(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Enter" || e.defaultPrevented) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target instanceof HTMLTextAreaElement && e.shiftKey) return;
  if (!target.matches(ENTER_FIELD_SELECTOR) || target.form) return;

  const panel = e.currentTarget;
  const fields = Array.from(
    panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(ENTER_FIELD_SELECTOR),
  ).filter((el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0);

  e.preventDefault();
  const next = fields[fields.indexOf(target) + 1];
  if (next) {
    next.focus();
    try {
      next.select();
    } catch {
      // Some input types don't support selection; focus alone is fine.
    }
    return;
  }
  const submit = panel.querySelector<HTMLButtonElement>("[data-modal-submit]");
  if (submit && !submit.disabled) submit.click();
}
