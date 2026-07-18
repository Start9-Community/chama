import type { SelectedMenuItem } from "./types.js";

/**
 * Media belongs to the CREATE listing, never to an order/LOCK snapshot.
 *
 * Older clients copied `imageDataUrl` into selected items. When that value
 * was an inline data URL, a perfectly small order could become a 90KB LOCK
 * event and be rejected by every relay. Keep this runtime sanitizer even
 * after the field is removed from the TypeScript shape: pending lock intents
 * saved by an older build can still contain it.
 */
export function compactSelectedMenuItems(
  items: readonly SelectedMenuItem[] | undefined,
): SelectedMenuItem[] | undefined {
  if (!items) return undefined;
  return items.map(item => {
    const { imageDataUrl: _legacyImage, ...compact } = item as SelectedMenuItem & {
      imageDataUrl?: unknown;
    };
    return compact;
  });
}
