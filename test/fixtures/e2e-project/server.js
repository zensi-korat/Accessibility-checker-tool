// Tiny SPA host for the E2E fixture test: every path gets the same shell,
// which renders by pathname (like a React Router app with basename "/app").
// Deliberately contains real accessibility defects.
const http = require('http');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo SPA</title></head>
<body><header><nav><a href="/app">Home</a> <a href="/app/about">About</a> <a href="/app/users">Users</a></nav></header>
<main id="root"></main>
<script>
  const p = location.pathname;
  const root = document.getElementById('root');
  const page = (h, body) => root.innerHTML = '<h1>' + h + '</h1>' + body;
  if (p === '/') page('Start', '<p><a href="/app">Open the app</a></p>');
  else if (p === '/app' || p === '/app/') page('Home', '<p>Welcome</p><img src="/logo.png">');
  else if (p === '/app/about') page('About', '<p style="color:#bbb;background:#fff">Low contrast text</p>');
  else if (p === '/app/users') page('Users', '<button><svg width="10" height="10"></svg></button>');
  else if (/^\\/app\\/users\\/new$/.test(p)) page('New user', '<label for="n">Name</label><input id="n"><input type="email" name="email"><button id=open>Open dialog</button><div id=dlg hidden role=dialog><button><svg width=8 height=8></svg></button></div>');
  else if (/^\\/app\\/users\\/\\w+$/.test(p)) page('User ' + p.split('/').pop(), '<p>Detail</p>');
  else if (p === '/app/admin/reports') page('Reports', '<table><tr><td>x</td></tr></table>');
  else if (p === '/app/settings') page('Settings', '<p>Settings</p>');
  else { document.title = 'Not Found'; page('404', ''); }
  const open = document.getElementById('open');
  if (open) open.onclick = () => { document.getElementById('dlg').hidden = false; };
</script></body></html>`;
http.createServer((req, res) => {
  if (req.url === '/logo.png') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
}).listen(Number(process.env.PORT) || 4791, () => console.log('spa ready'));
