// Length limits people see are in characters, so an accented letter or an
// emoji counts once. Where a server limits stored
// size (Audiobookshelf, Komga and RomM: 72; Kavita: 256), that byte limit is
// still checked, and the message says accented letters and emoji take more room.

export const characters = (value: string) => Array.from(value).length;
export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

// A new password: at least 12 characters, within the server's size limit.
export const newPasswordFits = (value: string, maxBytes = 1024) => characters(value) >= 12 && utf8Bytes(value) <= maxBytes;

// An audited reason: 10 to 1000 characters once trimmed.
export const reasonFits = (value: string) => { const n = characters(value.trim()); return n >= 10 && n <= 1000; };

// "12 to 72 characters (accented letters and emoji take up extra space)".
export const passwordLimitText = (maxBytes = 1024) => `12 to ${maxBytes} characters${maxBytes < 1024 ? ' (accented letters and emoji take up extra space)' : ''}`;

// What "printable ASCII" means to a person.
export const plainCharacters = 'English letters, numbers, spaces and standard symbols (no accents or emoji)';
