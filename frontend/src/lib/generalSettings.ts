// Only the application name and URLs are editable; session lifetimes and
// cookie security are fixed by the MUM build and are never sent.
export function generalSettingsPayload(values: { app_name: string; app_base_url: string; app_local_url?: string | null }) {
  return { app_name: values.app_name, app_base_url: values.app_base_url, app_local_url: values.app_local_url ?? '' };
}
