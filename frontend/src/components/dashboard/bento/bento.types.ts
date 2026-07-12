/** Column span presets for the 12-column Bento grid (lg breakpoint). */
export type BentoColSpan = 3 | 4 | 5 | 6 | 7 | 8 | 12;

/** Row span presets for tall tiles. */
export type BentoRowSpan = 1 | 2;

export type BentoTileSpan = {
  /** lg: grid columns (of 12) */
  col: BentoColSpan;
  /** Optional vertical span */
  row?: BentoRowSpan;
  /** md: grid columns (of 6). Defaults to min(col, 6) mapped to 6-col grid. */
  mdCol?: 3 | 4 | 6;
};
