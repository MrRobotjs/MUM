import type { ReactNode } from 'react';

type AppLayoutProps = {
  nav?: ReactNode;
  children: ReactNode;
};

const defaultNav = (
  <nav className="flex h-full w-full items-center justify-between gap-4 px-6 py-4">
    <div className="flex items-center gap-2">
      <span className="mask mask-squircle bg-primary/20 px-3 py-2 font-semibold uppercase tracking-wide text-primary">
        MUM
      </span>
      <span className="text-sm font-medium text-base-content/80">
        Multimedia User Manager
      </span>
    </div>
    <div className="flex items-center gap-2 text-sm text-base-content/60">
      <span className="badge badge-outline badge-sm">React Migration Preview</span>
    </div>
  </nav>
);

export const AppLayout = ({ nav = defaultNav, children }: AppLayoutProps) => {
  return (
    <div className="min-h-screen bg-base-200">
      <header className="border-b border-base-300 bg-base-100 shadow-sm">
        {nav}
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
        {children}
      </div>
    </div>
  );
};

export default AppLayout;
