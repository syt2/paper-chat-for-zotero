export interface PresentationTableLayoutMetrics {
  fontSize: number;
  margin: number;
  rowHeight: number;
}

/**
 * Small academic evidence tables should occupy their planned evidence region,
 * not remain a spreadsheet-sized island in the upper-left corner. Dense tables
 * still step down conservatively so cell wrapping remains bounded.
 */
export function resolvePresentationTableLayout(
  bodyRowCount: number,
  columnCount: number,
  boxHeight: number,
): PresentationTableLayoutMetrics {
  const totalRows = Math.max(1, bodyRowCount + 1);
  const availableRowHeight = Math.max(0.24, boxHeight / totalRows);
  if (bodyRowCount <= 5 && columnCount <= 4) {
    return {
      fontSize: bodyRowCount <= 4 ? 14 : 13.5,
      margin: 0.085,
      rowHeight: Math.min(0.98, availableRowHeight),
    };
  }
  if (bodyRowCount <= 7 && columnCount <= 5) {
    return {
      fontSize: 11.5,
      margin: 0.07,
      rowHeight: Math.min(0.72, availableRowHeight),
    };
  }
  return {
    fontSize: 9.5,
    margin: 0.055,
    rowHeight: Math.min(0.52, availableRowHeight),
  };
}
