export function constrainCompactBounds(bounds, area, gap = 20, minWidth = 560) {
  const availableWidth = Math.max(1, area.width - gap);
  const width = Math.min(Math.max(bounds.width, minWidth), availableWidth);
  const maxX = area.x + Math.max(0, area.width - width);
  const x = Math.min(Math.max(bounds.x, area.x), maxX);

  return {
    ...bounds,
    x,
    y: area.y,
    width,
  };
}
