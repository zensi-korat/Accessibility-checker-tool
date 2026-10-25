import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy } from 'react';
import { ROUTES, BASE } from '@/paths';
import Layout from './Layout';
import RequireAuth from './RequireAuth';
const Users = lazy(() => import('./pages/Users'));

export default function App({ items }: { items: { p: string }[] }) {
  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route path={ROUTES.HOME} element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="about" element={<About />} />
          <Route path={`${ROUTES.USERS}/*`} element={<RequireAuth><Users /></RequireAuth>} />
          <Route path={`${BASE}/reports`} element={<Reports />} />
          <Route path="old" element={<Navigate to="/" />} />
        </Route>
        <Route path={ROUTES.SETTINGS} element={<Settings />} />
        {items.map((i) => <Route key={i.p} path={i.p} element={<X />} />)}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
