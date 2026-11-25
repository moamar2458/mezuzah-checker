// Live camera with a helper that says if the picture is sharp, bright and level.
import { rgbaToGray, sharpness, brightness } from './imageproc.js';
import { findKlaf } from './klaf.js';

export class Camera {
  constructor(video, onStatus) {
    this.video = video; this.onStatus = onStatus;
    this.stream = null; this.timer = null; this.tilt = null; this.sharpHistory = [];
    this.probe = document.createElement('canvas');
    this.onOrient = (e) => { if (e.beta !== null) this.tilt = { beta: e.beta, gamma: e.gamma }; };
  }

  static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext; }

  /** The cameras of this device (a PC can have a built-in one and an external USB camera). Names show after the first permission. */
  static async list() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; }
  }

  async start(deviceId = null) {
    const size = { width: { ideal: 4096 }, height: { ideal: 3072 } };
    const ask = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video });
    try {
      this.stream = await ask(deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size });
    } catch (e) {
      if (!deviceId || e.name === 'NotAllowedError') throw e;
      this.stream = await ask({ facingMode: { ideal: 'environment' }, ...size }); // the chosen camera was unplugged
    }
    const tr = this.stream.getVideoTracks()[0];
    this.deviceId = (tr && tr.getSettings && tr.getSettings().deviceId) || deviceId;
    this.video.srcObject = this.stream;
    await this.video.play();
    // iPhone asks permission for the tilt sensor
    try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch { /* no tilt then */ }
    window.addEventListener('deviceorientation', this.onOrient);
    this.timer = setInterval(() => this.measure(), 350);
  }

  stop() {
    clearInterval(this.timer);
    window.removeEventListener('deviceorientation', this.onOrient);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }

  async torch(on) {
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track) return false;
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
  }

  /** Find the klaf in a small copy of the live picture (like a document scanner). Returns the corners as 0..1 of the picture. */
  findKlaf() {
    const v = this.video;
    const k = 200 / Math.max(v.videoWidth, v.videoHeight);
    const sw = Math.round(v.videoWidth * k), sh = Math.round(v.videoHeight * k);
    if (!this.small) this.small = document.createElement('canvas');
    this.small.width = sw; this.small.height = sh;
    const ctx = this.small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, sw, sh);
    const f = findKlaf(ctx.getImageData(0, 0, sw, sh).data, sw, sh, 200);
    if (!f) return null;
    return { full: f.full, quad: f.quad.map(([x, y]) => [x / sw, y / sh]) };
  }

  /** Ask the camera to focus on this place (0..1 of the picture), where the phone allows it. */
  async focusOn(x, y) {
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track) return;
    const now = Date.now();
    if (this.lastFocus && now - this.lastFocus.t < 2500 && Math.hypot(this.lastFocus.x - x, this.lastFocus.y - y) < 0.1) return;
    this.lastFocus = { t: now, x, y };
    const caps = (track.getCapabilities && track.getCapabilities()) || {};
    const c = { pointsOfInterest: [{ x, y }] };
    if (caps.focusMode && caps.focusMode.includes('continuous')) c.focusMode = 'continuous';
    try { await track.applyConstraints({ advanced: [c] }); } catch { /* this camera focuses by itself */ }
  }

  measure() {
    const v = this.video;
    if (!v.videoWidth) return;
    let klaf = null;
    try { klaf = this.findKlaf(); } catch { /* keep going without the frame */ }
    // look at the middle of the klaf (or of the picture) at full detail
    let cx = 0.5, cy = 0.5;
    if (klaf && !klaf.full) {
      cx = klaf.quad.reduce((s, p) => s + p[0], 0) / 4; cy = klaf.quad.reduce((s, p) => s + p[1], 0) / 4;
      this.focusOn(cx, cy);
    }
    const S = 400, sx = Math.min(v.videoWidth - S, Math.max(0, cx * v.videoWidth - S / 2)), sy = Math.min(v.videoHeight - S, Math.max(0, cy * v.videoHeight - S / 2));
    this.probe.width = S; this.probe.height = S;
    const ctx = this.probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, Math.max(0, sx), Math.max(0, sy), Math.min(S, v.videoWidth), Math.min(S, v.videoHeight), 0, 0, S, S);
    const gray = rgbaToGray(ctx.getImageData(0, 0, S, S).data, S, S);
    const sharp = sharpness(gray);
    const { mean, glare } = brightness(gray);
    const now = Date.now();
    this.sharpHistory = this.sharpHistory.filter((h) => now - h.t < 4000);
    this.sharpHistory.push({ t: now, v: sharp });
    const best = Math.max(...this.sharpHistory.map((h) => h.v));
    const status = {
      light: mean < 80 ? 'dark' : glare > 0.08 ? 'glare' : 'ok',
      sharp: sharp < 60 || sharp < best * 0.55 ? 'blurry' : 'ok',
      level: 'unknown',
      res: `${v.videoWidth}×${v.videoHeight}`,
      klaf,
    };
    if (this.tilt) {
      const off = Math.max(Math.abs(this.tilt.beta), Math.abs(this.tilt.gamma));
      status.level = off > 7 ? 'tilted' : 'ok';
      status.tiltDeg = off;
    }
    this.onStatus(status);
  }

  /** Take the best photo the camera can give. Returns an ImageBitmap or canvas. */
  async capture() {
    const track = this.stream.getVideoTracks()[0];
    if (typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(track);
        const blob = await ic.takePhoto();
        return await createImageBitmap(blob);
      } catch { /* fall back to a video frame */ }
    }
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth; c.height = this.video.videoHeight;
    c.getContext('2d').drawImage(this.video, 0, 0);
    return c;
  }
}
