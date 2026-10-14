/**
 * "A big change just happened" (a new note, something moved to Trash or deleted for good, a folder
 * deleted, an import): Drive backup listens and, when "Also back up right after a big change" is on,
 * backs up soon after (0.11). An event, so the code that makes the change knows nothing about Drive.
 */
export const BIG_CHANGE = 'upsc:bigchange';

export function bigChange(reason: string) {
  window.dispatchEvent(new CustomEvent(BIG_CHANGE, { detail: reason }));
}
