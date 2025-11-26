import { ReactNode } from 'react';
import { useLocation, Link } from '@tanstack/react-router';
import { AppSidebar } from './AppSidebar';
import { ModeToggle } from './ModeToggle';
import { NotificationDropdown } from './NotificationDropdown';
import { useAuth } from '../../contexts/AuthContext';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

type EnhancedAppLayoutProps = {
  children: ReactNode;
  showSidebar?: boolean;
};

const generateBreadcrumbs = (pathname: string) => {
  // Remove /admin prefix and split by /
  const paths = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);

  const breadcrumbs: { label: string; href: string }[] = [];
  let currentPath = '/admin';

  paths.forEach((segment, index) => {
    currentPath += `/${segment}`;
    // Capitalize and format the segment
    const label = segment
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    breadcrumbs.push({
      label,
      href: currentPath,
    });
  });

  return breadcrumbs;
};

export const EnhancedAppLayout = ({
  children,
  showSidebar = true,
}: EnhancedAppLayoutProps) => {
  const { session } = useAuth();
  const location = useLocation();

  const appName = session?.app_name || 'Multimedia User Manager';
  const breadcrumbs = generateBreadcrumbs(location.pathname);

  if (!showSidebar) {
    // Simple layout without sidebar (for login, public pages, etc.)
    return (
      <div className="flex min-h-screen flex-col">
        <header className="border-b border bg-card shadow-sm">
          <nav className="flex h-16 items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <span className="mask mask-squircle bg-primary/20 px-3 py-2 text-sm font-semibold uppercase tracking-wide text-primary">
                MUM
              </span>
              <span className="text-sm font-medium text-foreground/80">{appName}</span>
            </div>
            <ModeToggle />
          </nav>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-grow px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>

        <footer className="footer footer-center bg-muted p-4 text-foreground">
          <div>
            <p>
              © {new Date().getFullYear()} {appName}
            </p>
          </div>
        </footer>
      </div>
    );
  }

  // Layout with Shadcn sidebar
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "18rem",
          "--header-height": "4rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" collapsible="offcanvas" />
      <SidebarInset>
        {/* Header/Navbar */}
        <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink asChild>
                    <Link to="/admin/dashboard" className="max-w-[200px] truncate">{appName}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                {breadcrumbs.map((crumb, index) => {
                  const isLast = index === breadcrumbs.length - 1
                  const isPenultimate = index === breadcrumbs.length - 2
                  const showMobile = isLast || isPenultimate

                  return (
                    <span key={crumb.href} className="contents">
                      <BreadcrumbSeparator
                        className={
                          index === 0
                            ? "hidden md:block"
                            : showMobile
                            ? undefined
                            : "hidden md:block"
                        }
                      />
                      <BreadcrumbItem
                        className={
                          showMobile ? undefined : "hidden md:block"
                        }
                      >
                        {isLast ? (
                          <BreadcrumbPage className="max-w-[150px] truncate md:max-w-none">{crumb.label}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <Link to={crumb.href} className="max-w-[150px] truncate md:max-w-none">{crumb.label}</Link>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </span>
                  )
                })}
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ml-auto flex items-center gap-2">
              <NotificationDropdown />
              <ModeToggle />
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex flex-1 flex-col px-4 py-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
