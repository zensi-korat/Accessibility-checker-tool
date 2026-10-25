import type { RouteObject } from 'react-router-dom';
export const adminRoutes: RouteObject[] = [
  { index: true, element: <Dashboard /> },
  { path: 'users', lazy: () => import('./users') },
];
