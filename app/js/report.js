// Drawing the red circles of a report. Shared by the phone app and the PC screen.

/** Reading order: line by line from the top, right to left inside a line. */
export function sortIssues(issues, letterH = 40) {
  const band = letterH * 1.5;
  return issues.sort((a, b) => Math.round(a.y / band) - Math.round(b.y / band) || b.x - a.x);
}

/** Draw numbered red circles over an image already painted on ctx (image size w×h). */
export function paintIssues(ctx, w, issues, sel = -1) {
  const lw = Math.max(3, w / 450);
  ctx.font = `bold ${Math.max(16, w / 70)}px system-ui, sans-serif`;
  (issues || []).forEach((is, k) => {
    ctx.lineWidth = k === sel ? lw * 2 : lw;
    ctx.strokeStyle = k === sel ? '#ffcc00' : '#e00000';
    ctx.beginPath(); ctx.arc(is.x, is.y, is.r, 0, Math.PI * 2); ctx.stroke();
    const tx = is.x + is.r * 0.75, ty = is.y - is.r * 0.75;
    ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.strokeText(String(k + 1), tx, ty);
    ctx.fillStyle = '#e00000'; ctx.fillText(String(k + 1), tx, ty);
  });
}

export function paintBoxes(ctx, w, boxes) {
  ctx.lineWidth = Math.max(1, w / 1500);
  for (const b of boxes || []) {
    ctx.strokeStyle = b.op === 'M' ? 'rgba(0,140,255,.55)' : 'rgba(255,140,0,.8)';
    ctx.strokeRect(b.b[0], b.b[1], b.b[2] - b.b[0], b.b[3] - b.b[1]);
  }
}
