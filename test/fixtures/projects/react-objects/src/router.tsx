import { createBrowserRouter } from 'react-router-dom';
import { adminRoutes } from './admin/routes';

export const router = createBrowserRouter([
  {
    path: '/', element: <Root />, children: [
      { index: true, element: <Home /> },
      { path: 'products/:productId?', element: <Product /> },
      { path: 'admin', element: <ProtectedRoute />, children: adminRoutes },
      ...extraRoutes,
    ],
  },
  { path: '/login', Component: Login },
]);

const extraRoutes = [{ path: 'help', element: <Help /> }];
