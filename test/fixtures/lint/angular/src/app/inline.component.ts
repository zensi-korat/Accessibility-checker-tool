import { Component } from '@angular/core';

@Component({
  selector: 'app-inline',
  template: `
    <p>ok</p>
    <img [src]="url">
  `,
})
export class InlineComponent { url = 'x'; }
