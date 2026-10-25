import type { RouteRecordRaw } from 'vue-router';
export const adminRoutes: RouteRecordRaw[] = [
  { path: 'settings', component: () => import('../views/Settings.vue') },
];
