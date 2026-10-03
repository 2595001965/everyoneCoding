import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../db.ts';
import { WalletLedger, type ReserveAttemptInput } from '../models/wallet-ledger.ts';

const data = workerData as { dbPath: string; input: ReserveAttemptInput };
const database = openDatabase(data.dbPath);
const ledger = new WalletLedger(database);
parentPort!.postMessage({ ready: true });
parentPort!.once('message', (message: unknown) => {
  if (message !== 'reserve') return;
  try {
    const result = ledger.reserveAttempt(data.input);
    parentPort!.postMessage({ ok: true, attempt: result.attempt, wallet: result.wallet });
  } catch (error) {
    const value = error as { code?: string; message?: string };
    parentPort!.postMessage({
      ok: false,
      code: value.code ?? 'ERROR',
      message: value.message ?? String(error),
    });
  } finally {
    database.close();
    parentPort!.close();
  }
});
