// Runs the check in the background so the screen does not freeze.
import { analyze } from './pipeline.js';
import { parseReference } from './reference.js';
import { deserializeModel } from './nn.js';
import { setLang } from './i18n.js';

let model = null, modelKey = null;

self.onmessage = (e) => {
  const { id, rgba, w, h, refText, modelJson, sens, lang, spots, maxSide } = e.data;
  setLang(lang);
  try {
    if (modelJson && modelJson !== modelKey) { model = deserializeModel(modelJson); modelKey = modelJson; }
    if (!modelJson) { model = null; modelKey = null; }
    const ref = parseReference(refText);
    const res = analyze(new Uint8ClampedArray(rgba), w, h, { ref, model, sens, maxSide: maxSide || 3200, spots: spots && spots.length ? spots : null });
    const out = { ...res, rgba: res.rgba.buffer };
    self.postMessage({ id, ok: true, res: out }, [out.rgba]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};
