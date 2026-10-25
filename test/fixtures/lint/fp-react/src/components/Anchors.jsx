export const Anchors = () => (
  <nav>
    <a onClick={() => go()}>No href</a>
    <a href="#" onClick={() => go()}>Hash</a>
  </nav>
);
