import { useState, useEffect, useCallback } from 'react';
import { requestJson } from '../util/apiClient';
import { emitPreferenceChange, getPreference, setPreference } from '../util/preferences';

interface UserPreferencesData {
  preferences: Record<string, any>;
  sync_enabled: boolean;
}

interface UseUserPreferencesOptions {
  /**
   * Whether to automatically fetch preferences from the server on mount
   * Default: true
   */
  autoFetch?: boolean;
}

/**
 * Hook for managing user preferences with localStorage and optional DB sync
 *
 * Priority: DB (if sync enabled) > localStorage > default value
 *
 * Example usage:
 *   const { getPreference, setPreference, syncEnabled, toggleSync } = useUserPreferences();
 *   const streamCounter = getPreference('stream_counter', false);
 *   setPreference('stream_counter', true);
 */
export function useUserPreferences(options: UseUserPreferencesOptions = {}) {
  const { autoFetch = true } = options;

  const [dbPreferences, setDbPreferences] = useState<Record<string, any> | null>(null);
  const [syncEnabled, setSyncEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Fetch preferences from the server
   */
  const fetchPreferences = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await requestJson<UserPreferencesData>('/admin/api/v2/account/preferences');
      setDbPreferences(response.preferences);
      setSyncEnabled(response.sync_enabled);
    } catch (err) {
      console.error('Failed to fetch user preferences:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch preferences'));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Get a preference value
   * Priority: DB (if sync enabled) > localStorage > default
   */
  const getUserPreference = useCallback(<T = any>(key: string, defaultValue?: T): T => {
    // If sync is enabled and we have DB preferences, use those
    if (syncEnabled && dbPreferences && key in dbPreferences) {
      return dbPreferences[key] as T;
    }

    // Otherwise, try localStorage
    const localValue = getPreference<T>(key);
    if (localValue !== null) {
      return localValue;
    }

    // Fall back to default value
    return defaultValue as T;
  }, [syncEnabled, dbPreferences]);

  /**
   * Set a preference value
   * Saves to localStorage and optionally to DB if sync is enabled
   */
  const setUserPreference = useCallback(async <T = any>(key: string, value: T): Promise<void> => {
    // Always save to localStorage first
    setPreference(key, value);
    let synced = false;

    // If sync is enabled, also save to DB
    if (syncEnabled) {
      try {
        const updatedPreferences = {
          ...dbPreferences,
          [key]: value,
        };

        await requestJson('/admin/api/v2/account/preferences', {
          method: 'PATCH',
          body: JSON.stringify({ preferences: updatedPreferences }),
        });

        setDbPreferences(updatedPreferences);
        synced = true;
      } catch (err) {
        console.error('Failed to sync preference to DB:', err);
        // Don't throw - localStorage save succeeded
      }
    }

    if (!syncEnabled || synced) {
      emitPreferenceChange(key, value);
    }
  }, [syncEnabled, dbPreferences]);

  /**
   * Toggle sync preferences on/off
   * When enabling: migrates localStorage to DB
   * When disabling: preferences stay in DB but won't be used (localStorage takes priority)
   */
  const toggleSync = useCallback(async (enabled: boolean): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      // If enabling sync, migrate localStorage preferences to DB first
      if (enabled) {
        const localPrefs = {
          stream_counter: getPreference('stream_counter', false),
        };

        // Update preferences in DB
        await requestJson('/admin/api/v2/account/preferences', {
          method: 'PATCH',
          body: JSON.stringify({ preferences: localPrefs }),
        });

        setDbPreferences(localPrefs);
      }

      // Toggle sync setting
      const response = await requestJson<UserPreferencesData>('/admin/api/v2/account/preferences/sync', {
        method: 'PATCH',
        body: JSON.stringify({ sync_enabled: enabled }),
      });

      setSyncEnabled(response.sync_enabled);
      setDbPreferences(response.preferences);
    } catch (err) {
      console.error('Failed to toggle sync preferences:', err);
      setError(err instanceof Error ? err : new Error('Failed to toggle sync'));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-fetch on mount if enabled
  useEffect(() => {
    if (autoFetch) {
      fetchPreferences();
    }
  }, [autoFetch, fetchPreferences]);

  return {
    /**
     * Get a preference value with optional default
     */
    getPreference: getUserPreference,

    /**
     * Set a preference value (saves to localStorage and optionally DB)
     */
    setPreference: setUserPreference,

    /**
     * Whether sync is enabled
     */
    syncEnabled,

    /**
     * Toggle sync on/off
     */
    toggleSync,

    /**
     * Manually refresh preferences from server
     */
    refresh: fetchPreferences,

    /**
     * Loading state
     */
    loading,

    /**
     * Error state
     */
    error,

    /**
     * Raw DB preferences object
     */
    dbPreferences,
  };
}
