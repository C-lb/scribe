/**
 * Which slot a drop lands in, given the pointer's y position and the row
 * rectangles in visual order. A row counts as passed once the pointer is at
 * or below its midpoint, so the insertion line sits where the eye expects.
 */
export function insertionIndex(pointerY, rects) {
  let index = 0;
  for (const rect of rects) {
    if (pointerY < (rect.top + rect.bottom) / 2) break;
    index += 1;
  }
  return index;
}
