/**
 * apograph — Live terminal progress spinner (utils).
 *
 * Wraps `@clack/prompts` `p.spinner()` with an elapsed-seconds timer so
 * long-running stages (headless crawl, LLM synthesis, verification) show a
 * ticking `label (Ns elapsed)...` line, stopping with a final `message (Ns)`.
 */

import * as p from '@clack/prompts';

/** Handle over a running progress spinner. */
export interface ProgressHandle {
  /** Updates the spinner label without resetting the timer. */
  message(label: string): void;
  /** Stops the spinner with a final message including the elapsed time. */
  stop(finalMessage: string): void;
}

/** Starts a spinner for `label` that ticks elapsed seconds once per second. */
export function startProgress(label: string): ProgressHandle {
  const spinner = p.spinner();
  let elapsedSeconds = 0;
  let stopped = false;

  spinner.start(`${label} (0s)`);

  const timer: NodeJS.Timeout = setInterval(() => {
    if (stopped) return;
    elapsedSeconds += 1;
    spinner.message(`${label} (${elapsedSeconds}s elapsed)...`);
  }, 1000);

  return {
    message(nextLabel: string): void {
      if (stopped) return;
      spinner.message(`${nextLabel} (${elapsedSeconds}s elapsed)...`);
    },
    stop(finalMessage: string): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      spinner.stop(`${finalMessage} (${elapsedSeconds}s)`);
    },
  };
}

/** A no-op progress handle for non-terminal contexts. */
export const NULL_PROGRESS: ProgressHandle = {
  message(): void {},
  stop(): void {},
};
