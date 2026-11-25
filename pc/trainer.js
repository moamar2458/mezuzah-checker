// Runs one AI training in a background thread of the PC program.
import { parentPort, workerData } from 'node:worker_threads';
import { trainModel } from '../app/js/train-core.js';

const res = trainModel(workerData, (m) => parentPort.postMessage(m));
parentPort.postMessage({ type: 'done', ...res });
