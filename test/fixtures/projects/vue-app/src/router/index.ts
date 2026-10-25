import { createRouter, createWebHistory } from 'vue-router';
import { adminRoutes } from './admin';
import Home from '../views/Home.vue';

export const ROUTE_NAMES = { PROFILE: 'profile' } as const;

export default createRouter({
  history: createWebHistory('/portal/'),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/about', component: () => import('../views/About.vue') },
    { path: '/users', component: () => import('../views/Users.vue'), children: [
      { path: '', component: () => import('../views/UserList.vue') },
      { path: ':id', component: () => import('../views/UserDetail.vue'), meta: { requiresAuth: true } },
    ] },
    { path: `/${ROUTE_NAMES.PROFILE}`, component: () => import('../views/Profile.vue') },
    { path: '/admin', component: () => import('../views/AdminLayout.vue'), meta: { requiresAuth: true }, children: adminRoutes },
    { path: '/old', redirect: '/' },
    { path: '/:pathMatch(.*)*', component: () => import('../views/NotFound.vue') },
  ],
});
