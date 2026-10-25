import { Routes } from '@angular/router';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'login', loadComponent: () => import('./login/login.component').then(m => m.LoginComponent) },
  { path: 'admin', canActivate: [authGuard], loadChildren: () => import('./admin/admin.routes').then(m => m.ADMIN_ROUTES) },
  { path: 'legacy', loadChildren: () => import('./legacy/legacy.module').then(m => m.LegacyModule) },
  { path: 'old', loadChildren: './old/old.module#OldModule' },
  { path: 'home', redirectTo: '', pathMatch: 'full' },
  { path: 'products', children: [
    { path: '', component: ProductListComponent },
    { path: ':id', component: ProductDetailComponent },
  ] },
  { path: '**', component: NotFoundComponent },
];
