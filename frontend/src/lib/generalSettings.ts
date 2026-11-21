// Only the application name and public address are editable; session
// lifetimes and cookie security are fixed by the MUM build and are never sent.
export function generalSettingsPayload(values: { app_name: string; public_address: string }) {
  return { app_name: values.app_name, public_address: values.public_address.trim() };
}
