/* css3d.js : the DOM half of the css3d toolkit.
   Three helpers. Nothing here knows about flowers; it only builds trees
   of .c3d nodes and .c3d-face planes and sets their custom properties. */

/** Create a coordinate frame (an invisible .c3d node). */
export function node(parent, vars = {}, className = '') {
  return make(parent, `c3d ${className}`, vars);
}

/** Create a visible plane. kind: 'face' (centered) or 'hinge' (bottom pivot). */
export function face(parent, vars = {}, className = '', kind = 'face') {
  const cls = kind === 'hinge' ? 'c3d-face c3d-face--hinge' : 'c3d-face';
  return make(parent, `${cls} ${className}`, vars);
}

/** Create a bend segment chained onto the top edge of a plane. */
export function seg(parent, vars = {}, className = '') {
  return make(parent, `c3d-seg ${className}`, vars);
}

/** Place n copies around a ring: calls build(i, angleDeg) for each step. */
export function ring(n, build, offsetDeg = 0) {
  const step = 360 / n;
  for (let i = 0; i < n; i++) build(i, offsetDeg + i * step);
}

function make(parent, className, vars) {
  const el = document.createElement('div');
  el.className = className.trim();
  for (const [key, value] of Object.entries(vars)) {
    el.style.setProperty(`--${key}`, typeof value === 'number' ? String(value) : value);
  }
  if (parent) parent.appendChild(el);
  return el;
}
