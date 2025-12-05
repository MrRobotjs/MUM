/**
 * User preferences utility for localStorage management
 *
 * Key format: mum_pref_{preference_name}
 *
 * Example usage:
 *   getPreference('stream_counter') // returns value or null
 *   setPreference('stream_counter', true)
 *   removePreference('stream_counter')
 */

const PREFERENCE_PREFIX = 'mum_pref_';

/**
 * Get a preference from localStorage
 */
export function getPreference<T = any>(key: string): T | null {
  try {
    const storageKey = `${PREFERENCE_PREFIX}${key}`;
    const value = localStorage.getItem(storageKey);

    if (value === null) {
      return null;
    }

    return JSON.parse(value) as T;
  } catch (error) {
    console.error(`Failed to get preference "${key}":`, error);
    return null;
  }
}

/**
 * Set a preference in localStorage
 */
export function setPreference<T = any>(key: string, value: T): void {
  try {
    const storageKey = `${PREFERENCE_PREFIX}${key}`;
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch (error) {
    console.error(`Failed to set preference "${key}":`, error);
  }
}

/**
 * Remove a preference from localStorage
 */
export function removePreference(key: string): void {
  try {
    const storageKey = `${PREFERENCE_PREFIX}${key}`;
    localStorage.removeItem(storageKey);
  } catch (error) {
    console.error(`Failed to remove preference "${key}":`, error);
  }
}

/**
 * Clear all preferences from localStorage
 */
export function clearAllPreferences(): void {
  try {
    const keys = Object.keys(localStorage);
    const prefKeys = keys.filter(key => key.startsWith(PREFERENCE_PREFIX));

    prefKeys.forEach(key => {
      localStorage.removeItem(key);
    });
  } catch (error) {
    console.error('Failed to clear preferences:', error);
  }
}

/**
 * Get all preferences from localStorage
 */
export function getAllPreferences(): Record<string, any> {
  try {
    const keys = Object.keys(localStorage);
    const prefKeys = keys.filter(key => key.startsWith(PREFERENCE_PREFIX));

    const preferences: Record<string, any> = {};

    prefKeys.forEach(key => {
      const prefKey = key.replace(PREFERENCE_PREFIX, '');
      const value = getPreference(prefKey);
      if (value !== null) {
        preferences[prefKey] = value;
      }
    });

    return preferences;
  } catch (error) {
    console.error('Failed to get all preferences:', error);
    return {};
  }
}
