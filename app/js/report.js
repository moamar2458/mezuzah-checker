// Drawing the red circles of a report. Shared by the phone app and the PC screen.

/** Reading order: line by line from the top, right to left inside a line. */
export function sortIssues(issues, letterH = 40) {
  const band = letterH * 1.5;
  return issues.sort((a, b) => Math.round(a.y / band) - Math.round(b.y / band) || b.x - a.x);
}

/**
 * Draw the marks over an image already painted on ctx (image size w×h):
 * a thin circle around the letter, a small circle on the exact place, an arrow pointing to it, and the number.
 * The selected mark also shows its short reason.
 */
export function paintIssues(ctx, w, issues, sel = -1) {
  const lw = Math.max(3, w / 450);
  const fs = Math.max(16, w / 70);
  (issues || []).forEach((is, k) => {
    const on = k === sel;
    const col = is.answer ? (is.answer.verdict === 'kosher' ? '#0a8f3c' : is.answer.verdict === 'mehudar' ? '#c77700' : '#e00000') : '#e00000';
    const color = on ? '#ffcc00' : col;
    const px = is.px ?? is.x, py = is.py ?? is.y;
    const exact = Math.hypot(px - is.x, py - is.y) > 1 || is.kind === 'hole' || is.kind === 'thin';
    // the letter (thin, faint) and the exact place (small, strong)
    ctx.lineWidth = lw * (exact ? 0.6 : on ? 2 : 1); ctx.strokeStyle = color; ctx.globalAlpha = exact ? 0.55 : 1;
    ctx.beginPath(); ctx.arc(is.x, is.y, is.r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    let tx = is.x + is.r * 0.75, ty = is.y - is.r * 0.75;
    if (exact) {
      const sr = Math.max(lw * 2.5, is.r * 0.28);
      ctx.lineWidth = on ? lw * 1.6 : lw; ctx.beginPath(); ctx.arc(px, py, sr, 0, Math.PI * 2); ctx.stroke();
      // arrow from up-right, pointing at the place
      const L = is.r * 1.5, ax = px + L * 0.7, ay = py - L * 0.7, ex = px + sr * 0.75, ey = py - sr * 0.75;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
      const hl = Math.max(lw * 3, sr * 0.9), ang = Math.atan2(ey - ay, ex - ax);
      ctx.beginPath(); ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(ang - 0.45), ey - hl * Math.sin(ang - 0.45));
      ctx.lineTo(ex - hl * Math.cos(ang + 0.45), ey - hl * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fillStyle = color; ctx.fill();
      tx = ax + lw; ty = ay - lw;
    }
    ctx.font = `bold ${fs}px system-ui, sans-serif`;
    ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.strokeText(String(k + 1), tx, ty);
    ctx.fillStyle = color === '#ffcc00' ? '#b08800' : color; ctx.fillText(String(k + 1), tx, ty);
    if (on && is.why) {
      // the short reason, on a white label next to the number
      ctx.font = `bold ${fs * 0.9}px system-ui, sans-serif`;
      const txt = is.why, tw = ctx.measureText(txt).width, pad = fs * 0.3;
      const bx = Math.min(w - tw - pad * 2, tx + fs * 1.4), by = ty - fs * 0.9;
      ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(bx, by - pad, tw + pad * 2, fs * 1.1 + pad * 2);
      ctx.strokeStyle = '#b08800'; ctx.lineWidth = 2; ctx.strokeRect(bx, by - pad, tw + pad * 2, fs * 1.1 + pad * 2);
      ctx.fillStyle = '#111'; ctx.textBaseline = 'top'; ctx.fillText(txt, bx + pad, by); ctx.textBaseline = 'alphabetic';
    }
  });
}

export function paintBoxes(ctx, w, boxes) {
  ctx.lineWidth = Math.max(1, w / 1500);
  for (const b of boxes || []) {
    ctx.strokeStyle = b.op === 'M' ? 'rgba(0,140,255,.55)' : 'rgba(255,140,0,.8)';
    ctx.strokeRect(b.b[0], b.b[1], b.b[2] - b.b[0], b.b[3] - b.b[1]);
  }
}
