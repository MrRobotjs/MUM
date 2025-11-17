const SettingsPlaceholderPage = () => {
  return (
    <div className="rounded-xl border border-dashed border bg-card p-8 text-center shadow-sm">
      <h1 className="text-2xl font-semibold text-foreground">Settings (React Migration)</h1>
      <p className="mt-4 text-sm text-muted-foreground">
        Settings pages are moving to the new React interface. In the meantime, use the existing
        navigation to manage users and configuration.
      </p>
    </div>
  );
};

export default SettingsPlaceholderPage;
