/**
 * Marks the tool leaves in the page.
 *
 * Highlighting writes an attribute on every marked element and injects an
 * overlay container, so the page carries traces of the extraction itself.
 * Anything that watches the page for change has to be able to tell those
 * apart from the page doing something — otherwise the tool's own overlay
 * reports the page as busy, every time, forever.
 */

/** Carries the element's index so the injected overlay script can find it. */
export const HIGHLIGHT_ATTR = 'data-hl-idx';

/** The injected overlay that draws the boxes. */
export const HIGHLIGHT_CONTAINER_ID = '__elements_highlight_container__';
