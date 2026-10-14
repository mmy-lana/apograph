/**
 * apograph — Graceful interruption trap (utils).
 *
 * Traps SIGINT (Ctrl+C) during long-running pipeline stages: stops any
 * active spinner, offers an interactive Clack modal (save checkpoint /
 * abort / continue), persists `.apograph/checkpoint.json` on save, and
 * exits cleanly. Non-interactive runs abort with exit code 1 immediately.
 */

import { rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { exit } from 'node:process';
import * as p from '@clack/prompts';

/** Pipeline stages checkpointed across a clone run. */
export type CloneStage = 'crawl' | 'plan' | 'synthesize' | 'emit' | 'verify' | 'done';

/** The persisted checkpoint shape (`.apograph/checkpoint.json`). */
export interface CloneCheckpoint {
  /** The target URL of the interrupted run. */
  targetUrl: string;
  /** The stage the run had reached when interrupted. */
  stage: CloneStage;
  /** ISO-8601 timestamp of the save. */
  savedAt: string;
  /** Evidence directory used by the run. */
  evidenceDir: string;
  /** Output directory the run emits into. */
  outDir: string;
  /** Viewport mode of the run. */
  viewport: 'both' | 'desktop' | 'mobile';
  /** Route paths whose page files were already synthesized. */
  completedRoutePaths: string[];
}

/** Default checkpoint location (relative to cwd). */
export const CHECKPOINT_PATH = '.apograph/checkpoint.json';

/** Context the trap needs to save a checkpoint and manage the spinner. */
export interface InterruptContext {
  /** Working directory holding `.apograph/` (checkpoint root). */
  workingDir: string;
  /** True when interactive prompts may be shown. */
  interactive: boolean;
  /** Stops the active progress spinner without a misleading final message. */
  stopSpinner(): void;
  /** Snapshot provider — returns the checkpoint to persist on save. */
  checkpoint(): CloneCheckpoint;
  /** Restarts the progress spinner after choosing "continue". */
  restartSpinner(): void;
}

/** Reads and validates a checkpoint file, or null when absent/invalid. */
export async function loadCheckpoint(
  workingDir: string = '.',
): Promise<CloneCheckpoint | null> {
  const path = join(resolve(workingDir), CHECKPOINT_PATH);

  try {
    const raw: unknown = JSON.parse(
      await (await import('node:fs/promises')).readFile(path, 'utf8'),
    );

    if (typeof raw !== 'object' || raw === null) return null;
    const candidate = raw as Partial<CloneCheckpoint>;

    if (
      typeof candidate.targetUrl !== 'string' ||
      typeof candidate.stage !== 'string' ||
      typeof candidate.savedAt !== 'string' ||
      !Array.isArray(candidate.completedRoutePaths)
    ) {
      return null;
    }

    return {
      targetUrl: candidate.targetUrl,
      stage: candidate.stage as CloneStage,
      savedAt: candidate.savedAt,
      evidenceDir: candidate.evidenceDir ?? '.apograph/evidence',
      outDir: candidate.outDir ?? '',
      viewport: candidate.viewport ?? 'both',
      completedRoutePaths: candidate.completedRoutePaths,
    };
  } catch {
    return null;
  }
}

/** Persists a checkpoint to `<workingDir>/.apograph/checkpoint.json`. */
export async function saveCheckpoint(
  workingDir: string,
  checkpoint: CloneCheckpoint,
): Promise<string> {
  const path = join(resolve(workingDir), CHECKPOINT_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint, null, 2), 'utf8');
  return path;
}

/** Deletes the checkpoint file (after a successful run). */
export async function clearCheckpoint(workingDir: string = '.'): Promise<void> {
  await rm(join(resolve(workingDir), CHECKPOINT_PATH), { force: true });
}

/**
 * Installs the SIGINT trap. Returns a disposer that removes the handler
 * (call this once the pipeline finishes normally).
 */
export function setupInterruptTrap(context: InterruptContext): () => void {
  const handler = (): void => {
    context.stopSpinner();

    if (!context.interactive) {
      // Non-interactive runs cannot prompt — abort without saving.
      console.error('\n✖ Interrupted (non-interactive): aborting.');
      exit(1);
    }

    void (async () => {
      const action = await p.select({
        message: 'Process interrupted. What would you like to do?',
        options: [
          {
            value: 'save' as const,
            label: '1. Save checkpoint and exit (can resume later)',
          },
          { value: 'abort' as const, label: '2. Abort and discard current run' },
          { value: 'continue' as const, label: '3. Continue process' },
        ],
      });

      if (p.isCancel(action)) {
        exit(1);
      }

      if (action === 'save') {
        const checkpoint = context.checkpoint();
        const path = await saveCheckpoint(context.workingDir, checkpoint);
        p.outro(`Checkpoint saved to ${path}. Run \`apograph resume\` to continue.`);
        exit(0);
      }

      if (action === 'abort') {
        p.outro('Run aborted.');
        exit(1);
      }

      // continue: restart the spinner; the pipeline keeps running.
      context.restartSpinner();
    })();
  };

  process.on('SIGINT', handler);

  return () => {
    process.removeListener('SIGINT', handler);
  };
}
