import { Routes } from '@angular/router';
export const ADMIN_ROUTES: Routes = [
  { path: '', component: AdminDashboardComponent },
  { path: 'users/:id', component: UserEditComponent },
];
