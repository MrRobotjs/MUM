// The one check for a play's poster link, matching the server's single poster
// rule: the title's catalogue poster (as on the library pages), else the
// poster stored with the play, from MUM's recordings or an imported play.

const cataloguePoster = '/api/media/images/';
const storedPoster = { mum: '/api/activity/history-images/', imported: '/api/activity/imported-history-images/' } as const;

/** Whether a value is a poster link MUM gives a play: a catalogue poster, or the stored poster of that kind of play ('any' allows both kinds). */
export function isPlayPoster(value: unknown, source: 'mum' | 'imported' | 'any' = 'any'): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[#\s]/.test(value)) return false;
  if (value.startsWith(cataloguePoster)) return true;
  return source === 'any' ? value.startsWith(storedPoster.mum) || value.startsWith(storedPoster.imported) : value.startsWith(storedPoster[source]);
}
