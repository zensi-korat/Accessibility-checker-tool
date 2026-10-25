import React from 'react';

export default function App() {
  return (
    <main>
      <img src="/logo.png" />
      <div onClick={() => go()}>Open</div>
      <a href="/x"></a>
      <input tabIndex={3} />
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <img src="/ignored.png" />
      <div role="buton">x</div>
    </main>
  );
}
