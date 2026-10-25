import Link from 'next/link';
export function Form({ user, ...props }) {
  return (
    <div>
      <UserCard role="admin" />
      <label htmlFor="e">Email</label><input id="e" />
      <input autoFocus />
      <ul role="menu"><li role="menuitem" tabIndex={-1} onClick={() => {}} onKeyDown={() => {}}>A</li></ul>
      <img {...props} />
      <img src="real-missing-alt.png" />
      <Link href="/x">Go</Link>
    </div>
  );
}
