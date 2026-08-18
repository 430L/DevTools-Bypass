// Bonto and some hosting platforms launch `node server.js` at the repo root
// instead of `npm start`. Delegate to the real entrypoint under src/.
require("./src/server");
