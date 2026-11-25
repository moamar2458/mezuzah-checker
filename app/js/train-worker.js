// Trains the small letter AI in the background (browser).
import { trainModel } from './train-core.js';

self.onmessage = (e) => {
  const res = trainModel(e.data, (m) => self.postMessage(m));
  self.postMessage({ type: 'done', model: res.model, valAcc: res.valAcc, confusion: res.confusion });
};
