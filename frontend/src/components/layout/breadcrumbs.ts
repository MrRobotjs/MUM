import { isAdminPath } from '@/router/routePaths';

export const generateBreadcrumbs = (pathname: string) => {
  // Remove /admin prefix and split by /
  const paths = (isAdminPath(pathname) ? pathname.replace(/^\/admin\/?/, '') : pathname).split('/').filter(Boolean);

  const breadcrumbs: { label: string; href: string; search?: { tab: 'episodes' } }[] = [];
  let currentPath = isAdminPath(pathname) ? '/admin' : '';

  paths.forEach((segment, index) => {
    const parentPath = currentPath;
    currentPath += `/${segment}`;
    // Capitalize and format the segment
    // The admin servers page is the sidebar's "Media Servers" page.
    const label = segment === 'servers' && index === 0 && isAdminPath(pathname) ? 'Media Servers' : segment
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    // An episode's address has no page at ".../<show>/episodes"; that crumb
    // opens the show's Episodes tab instead.
    if (segment === 'episodes' && paths[0] === 'servers' && paths[3] === 'libraries' && index === 6) {
      breadcrumbs.push({ label, href: parentPath, search: { tab: 'episodes' } });
      return;
    }
    breadcrumbs.push({
      label,
      href: paths[0] === 'servers' && index === 1 ? '/admin/servers' : currentPath,
    });
  });

  return breadcrumbs;
};

