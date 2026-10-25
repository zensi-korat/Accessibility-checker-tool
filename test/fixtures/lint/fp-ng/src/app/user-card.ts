import { Component } from '@angular/core';

@Component({
  selector: 'app-user-card',
  template: `
    <p>card</p>
    <img [src]="url">
  `,
})
export class UserCard { url = 'x'; }
