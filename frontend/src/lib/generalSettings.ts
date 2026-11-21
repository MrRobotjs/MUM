// The editable General settings: the application name, the public address and
// how long sign-ins last. Cookie security is never sent: HTTPS detection and
// the --secure-cookies option decide it.
export function generalSettingsPayload(values: { app_name: string; public_address: string; session_idle_days: number; session_max_days: number }) {
  return { app_name: values.app_name, public_address: values.public_address.trim(), session_idle_days: Number(values.session_idle_days), session_max_days: Number(values.session_max_days) };
}
