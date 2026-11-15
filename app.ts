// Adapter: main.ts (the kit lifecycle) imports createApp from './app.ts'.
// The server itself lives in forge.ts; this file only re-exports it.

export { createApp, startServer } from './forge.ts';
