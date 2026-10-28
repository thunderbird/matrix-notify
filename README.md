# matrix-notify

A small JavaScript library that sends messages to Matrix rooms. Thunderbird support tools use it to post to rooms on chat.mozilla.org. It works in web pages (Quick sites, GitHub Pages) and in Node (for example GitHub Actions). It has no dependencies.

There are two ways to log in. Both use the same code to send.

- People: the page calls `login()`. The person logs in on the single sign-on page of the Matrix server and comes back to the page. The access token stays in that browser (localStorage), and messages come from that person.
- Bots: an automated job passes a bot account token to `create()`. Keep the token in a secret, for example a GitHub Actions secret. Never put a bot token in a web page, because everyone who can open the page can read it.

## Use it in a web page

```html
<script src="https://thunderbird.github.io/matrix-notify/1/matrix-notify.js"></script>
<script>
  const mx = MatrixNotify.create();          // chat.mozilla.org by default
  const ROOM = '#my-room:mozilla.org';

  // Call this on every page load. It finishes a login when the person comes back.
  mx.completeLogin().then(r => {
    if (r.failed.length) alert('Some Matrix messages failed: ' + r.failed.map(f => f.error).join(', '));
  });

  async function announce(title, url) {
    const message = MatrixNotify.format({ title, url, lines: ['Tags: TIL'] });
    if (mx.isLoggedIn()) return mx.send(ROOM, message);
    // Not logged in: keep the message, log in, and send it when the person comes back.
    mx.login({ pending: [{ room: ROOM, message }] });
  }
</script>
```

The person must be allowed to join the room. The library joins the room before the first message. The room must not use end-to-end encryption, because the library sends plain messages.

## Use it in Node or GitHub Actions (bot)

```js
require('./matrix-notify.js');               // or: await import('./matrix-notify.js')
const mx = MatrixNotify.create({ accessToken: process.env.MATRIX_TOKEN });
await mx.send('#my-room:mozilla.org', MatrixNotify.format({ title: 'Spike report', url: 'https://example.org/report' }));
```

Node 18 or later is necessary, because the library uses `fetch`.

## API

- `MatrixNotify.create({ homeserver, accessToken, userId, storageKey, storage, deviceName })` returns a client. All options are optional. `homeserver` is the client API address (default `https://mozilla.modular.im`, the server of chat.mozilla.org). If two tools share one web address, give each tool its own `storageKey`.
- `client.send(room, message)` sends to a room alias (`#room:server`) or a room id (`!id:server`). `message` is a string or `{ text, html }`. It returns the event id.
- `client.login({ returnTo, pending })` opens the single sign-on page (browser only). `pending` is a list of `{ room, message }` to send after the login.
- `client.completeLogin()` finishes a login and sends the pending messages. It returns `{ completed, loggedIn, userId, sent, failed }`. `completed` is true when this call finished a login.
- `client.isLoggedIn()`, `client.userId()`, `client.pending()` and `client.logout()`.
- `MatrixNotify.format({ title, url, lines })` makes the shared message format: the title as a link, then one line for each item in `lines`.
- `MatrixNotify.discover(serverName)` finds the client API address of a server, for example `discover('mozilla.org')`.
- Errors are `MatrixNotify.MatrixError` objects with `status` and `errcode` (for example `M_FORBIDDEN`).

## Versions

The folder `1/` is version 1. Changes in `1/` must not break pages that use it. A change that breaks pages goes into a new folder, `2/`.
