// Entry point for a make.fun trial: this process is the bridge between the
// forge in app.ts and the environment running the checks. It starts the
// forge on a port the operating system picks, tells the environment which
// port that is, and then waits — polling, never guessing — until the
// environment reports the trial is finished. The checks themselves all run
// against the forge; nothing in this file is scored except that the forge
// stays up until the environment says stop.
//
// The sequence, step by step:
//
//   - MAKEFUN_ENV_URL names the environment's origin. If it is absent
//     there is nobody to register with, so the process gives up at once
//     with exit code 1.
//   - The forge listens on port 0, which asks the kernel for any free
//     port. Port 8080 is the environment's own port and is never taken.
//   - The process POSTs {"port": N} to <env>/register. The environment
//     remembers where the request came from plus N, and that becomes the
//     address the checks dial. If another entry registered first the
//     answer is 409; that changes nothing — this process waits anyway.
//   - The process GETs <env>/done over and over until the body reads
//     {"done": true}. The environment answers each poll immediately, so
//     this is a loop of short requests, not one held-open request. A
//     failed poll backs off briefly and tries again; the process never
//     leaves early.
//   - Once done is true, the forge is closed and the process exits 0.
//
// The only import is the forge itself. No third-party package, no Node
// built-in module, no model call anywhere in here.

import { createApp } from "./app.ts";

// The environment's origin, with any trailing slashes trimmed off.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

// One HTTP round trip may take at most this long before it is dropped.
const callBudgetMs = 30_000;
// The pause after the first failed attempt, and the longest pause allowed.
const pauseFirstMs = 250;
const pauseCeilingMs = 2_000;

// End the process with the given code, from anywhere below.
function leave(code: number): never {
  process.exit(code);
}

// Wait `ms` milliseconds.
function pause(ms: number): Promise<void> {
  return new Promise((wake) => setTimeout(wake, ms));
}

// The pause after `failures` failed attempts: doubling from pauseFirstMs,
// never past pauseCeilingMs.
function pauseAfter(failures: number): number {
  const steps = Math.min(failures, 8);
  return Math.min(pauseCeilingMs, pauseFirstMs * 2 ** steps);
}

// Tell the environment which port the forge is listening on. A 200 means
// the port was recorded; a 409 means another entry got there first, which
// is fine — this process still waits for the trial. A 400 or 405 means the
// request itself was wrong, so that is fatal; anything else (a dropped
// connection, the environment still starting, an unexpected status) is
// retried after a short pause.
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const payload = JSON.stringify({ port: port });
      const reply = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(callBudgetMs),
      });
      if (reply.status === 200 || reply.status === 409) {
        return;
      }
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register was refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("register was refused with HTTP ")) {
        throw error;
      }
    }
    await pause(pauseAfter(failures));
  }
}

// One poll of GET /done: true only when the environment answers
// {"done": true}. Anything else — a non-OK status, a body that is not
// JSON, done still false — is false, never an exception here.
async function probeDone(): Promise<boolean> {
  const reply = await fetch(`${envOrigin}/done`, {
    signal: AbortSignal.timeout(callBudgetMs),
  });
  if (!reply.ok) {
    return false;
  }
  const payload = (await reply.json()) as { done?: unknown };
  return payload.done === true;
}

// Ask the environment whether the trial is over, again and again, until
// it says so. A failed poll just means "not yet", so pause briefly and
// ask again. This never returns early.
async function awaitFinished(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    const finished = await probeDone().catch(() => false);
    if (finished) {
      return;
    }
    await pause(pauseAfter(failures));
  }
}

// The whole life of this process: start the forge, announce its port,
// wait for the environment to finish, then shut the forge down.
async function run(): Promise<void> {
  if (envOrigin === "") {
    throw new Error("MAKEFUN_ENV_URL is missing, so there is no environment to join");
  }
  const forge = createApp();
  await new Promise<void>((ready, broken) => {
    forge.once("error", broken);
    forge.listen(0, () => ready());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the forge did not bind a TCP port");
  }
  process.stdout.write(`[entrypoint] forge listening on port ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write("[entrypoint] registered with the environment, waiting for done\n");
  await awaitFinished();
  forge.close();
  process.stdout.write("[entrypoint] environment says done, shutting down\n");
}

run().then(
  () => leave(0),
  (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[entrypoint] ${detail}\n`);
    leave(1);
  },
);
