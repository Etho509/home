/*
 * mixing.js
 *
 * This module provides all of the core colour mixing and search
 * logic used by the Joy of Painting colour mixer.  Functions are
 * exposed both for consumption in the browser (via the global
 * `Mixer` object) and in a Node environment (via `module.exports`).
 *
 * The mixing algorithm implemented here mirrors the vanilla
 * Minecraft leather dyeing system.  Colours are averaged in the
 * linear RGB domain and then normalised so that the maximum
 * channel of the average retains the average of the maxima of
 * the inputs.  All arithmetic uses integer division to match
 * the in‑game rounding behaviour.
 *
 * A beam search is used to explore the space of possible dye
 * combinations up to a user supplied depth.  Two‑step search can
 * optionally be enabled to improve performance on deeper searches
 * by first exploring part of the space and then refining the best
 * candidates.  Memoisation caches the result of mixing any given
 * multiset of dyes so that repeated combinations are not
 * recomputed.
 */

(function (global) {
  'use strict';

  /**
   * Dictionary of available dyes and their in‑game measured hex values.
   * The keys correspond to the vanilla dye names and the values are
   * six digit hex strings without the leading '#'.  These values were
   * measured on a JoP canvas rather than vanilla leather armour and
   * therefore include any quirks from the mod's palette implementation.
   */
  const DYE_HEX = {
    black: '1D1D21',
    red: 'AE2D26',
    green: '5D7B16',
    brown: '815331',
    blue: '3B43A8',
    purple: '8731B6',
    cyan: '169A9A',
    light_gray: '9B9B95',
    gray: '464E51',
    pink: 'F089A8',
    lime: '7EC51F',
    yellow: 'FBD53C',
    light_blue: '39B1D7',
    magenta: 'C54DBB',
    orange: 'F67E1D',
    white: 'FFFFFF'
  };

  /**
   * Convert a hex string (with or without leading '#') into an RGB
   * object.  The returned object contains integer r, g and b values
   * in the range 0‑255.  Throws if the supplied string is invalid.
   *
   * @param {string} hex hex colour definition
   * @returns {{r:number,g:number,b:number}}
   */
  function hexToRgb(hex) {
    let clean = hex.replace(/^#/, '').trim();
    if (clean.length === 3) {
      clean = clean
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
      throw new Error('Invalid hex colour: ' + hex);
    }
    const intVal = parseInt(clean, 16);
    return {
      r: (intVal >> 16) & 0xff,
      g: (intVal >> 8) & 0xff,
      b: intVal & 0xff
    };
  }

  /**
   * Convert an sRGB channel value (0‑255) into linear RGB
   * (0‑1) using the standard gamma expansion.  See
   * https://en.wikipedia.org/wiki/SRGB for details.
   *
   * @param {number} channel sRGB value in 0–255
   * @returns {number} linear value in 0–1
   */
  function srgbToLinear(channel) {
    const c = channel / 255;
    return c <= 0.04045
      ? c / 12.92
      : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /**
   * Convert a linear RGB channel value (0‑1) back to sRGB (0‑255).
   * Values are clamped to the range 0–1 before conversion.  See
   * https://en.wikipedia.org/wiki/SRGB for details.
   *
   * @param {number} channel linear value in 0–1
   * @returns {number} sRGB value in 0–255
   */
  function linearToSrgb(channel) {
    const c = Math.max(0, Math.min(1, channel));
    const srgb =
      c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  }

  /**
   * Convert an RGB triple (array or object) into CIELAB.  The
   * conversion uses the D65 reference white.  Internally the sRGB
   * values are converted into linear RGB, then XYZ and finally LAB.
   *
   * @param {number[]} rgb array [r,g,b] with values 0–255
   * @returns {{L:number,a:number,b:number}}
   */
  function rgbToLab(rgb) {
    // sRGB -> linear
    let [r, g, b] = rgb;
    r = srgbToLinear(r);
    g = srgbToLinear(g);
    b = srgbToLinear(b);
    // linear RGB -> XYZ
    // using sRGB D65 standard matrix
    const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
    // D65 white reference
    const Xn = 0.95047;
    const Yn = 1.0;
    const Zn = 1.08883;
    let fx = x / Xn;
    let fy = y / Yn;
    let fz = z / Zn;
    const epsilon = 216 / 24389;
    const kappa = 24389 / 27;
    fx = fx > epsilon ? Math.cbrt(fx) : (kappa * fx + 16) / 116;
    fy = fy > epsilon ? Math.cbrt(fy) : (kappa * fy + 16) / 116;
    fz = fz > epsilon ? Math.cbrt(fz) : (kappa * fz + 16) / 116;
    const L = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const bVal = 200 * (fy - fz);
    return { L, a, b: bVal };
  }

  /**
   * Compute the CIE76 ΔE (Euclidean distance in Lab space) between
   * two Lab colours.  This is a quick approximation suitable for
   * ranking candidate colours.  For more perceptually uniform
   * differences consider ΔE94 or ΔE2000; however, for our search
   * heuristic the simple CIE76 distance is sufficient.
   *
   * @param {{L:number,a:number,b:number}} lab1 first colour
   * @param {{L:number,a:number,b:number}} lab2 second colour
   * @returns {number} the ΔE76 distance
   */
  function deltaE(lab1, lab2) {
    const dL = lab1.L - lab2.L;
    const da = lab1.a - lab2.a;
    const db = lab1.b - lab2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  /**
   * Precompute useful data for each dye.  Each entry contains the
   * integer RGB components, the maximum channel (for brightness
   * normalisation), the Lab representation and linear RGB
   * components.  Precomputing these values up front speeds up the
   * search considerably.
   */
  const dyeData = {};
  for (const name in DYE_HEX) {
    const rgb = hexToRgb(DYE_HEX[name]);
    dyeData[name] = {
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      max: Math.max(rgb.r, rgb.g, rgb.b),
      lab: rgbToLab([rgb.r, rgb.g, rgb.b]),
      linear: {
        r: srgbToLinear(rgb.r),
        g: srgbToLinear(rgb.g),
        b: srgbToLinear(rgb.b)
      }
    };
  }

  // Base canvas colour: the JoP canvas is white (#FFFFFF).  When no
  // dyes are mixed the result is plain white.  Unlike leather dyeing
  // the base colour is *not* included in the averaging – only the
  // dyes themselves participate in the mix.  The base is used
  // solely as the output when the dye count is zero.  See
  // PaletteUtil.CustomColor.calculateResult() where the result is
  // computed only from the accumulated dyes; the emptiness colour is
  // returned when no dyes have been added.
  const BASE = {
    r: 255,
    g: 255,
    b: 255,
    max: 255,
    lab: rgbToLab([255, 255, 255]),
    linear: {
      r: srgbToLinear(255),
      g: srgbToLinear(255),
      b: srgbToLinear(255)
    }
  };

  /**
   * Compute the final RGB colour resulting from mixing the base
   * canvas colour with the supplied multiset of dyes.  The
   * implementation follows the vanilla dye mixing rules: the red,
   * green and blue channels are summed across all colours, as is
   * the per‑colour maximum.  These sums are then divided by the
   * total number of colours (base + dyes) using integer division.
   * Finally the average channels are scaled up by the ratio of the
   * average of maxima to the maximum of the averages.  All
   * intermediate values use integers so that the final result
   * matches in‑game behaviour exactly.
   *
   * @param {object} counts mapping from dye name to the number of times
   *                         that dye appears in the mix
   * @returns {{r:number,g:number,b:number}} the mixed colour
   */
  function mixCounts(counts) {
    // Totals across dyes only; base is not included.  If no dyes are
    // present return the white canvas colour.
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalMax = 0;
    let n = 0;
    for (const name in counts) {
      const count = counts[name];
      if (!count || count <= 0) continue;
      const dye = dyeData[name];
      totalR += dye.r * count;
      totalG += dye.g * count;
      totalB += dye.b * count;
      totalMax += dye.max * count;
      n += count;
    }
    if (n === 0) {
      return { r: BASE.r, g: BASE.g, b: BASE.b };
    }
    const avgR = Math.floor(totalR / n);
    const avgG = Math.floor(totalG / n);
    const avgB = Math.floor(totalB / n);
    const avgMax = Math.floor(totalMax / n);
    const maxOfAvg = Math.max(avgR, avgG, avgB);
    if (maxOfAvg === 0) {
      return { r: 0, g: 0, b: 0 };
    }
    const gain = Math.floor(avgMax / maxOfAvg);
    return { r: avgR * gain, g: avgG * gain, b: avgB * gain };
  }

  /**
   * Compute the Lab representation of the mixed colour for the
   * supplied multiset of dyes.  Uses memoisation to avoid
   * recomputing the same combination repeatedly.  The key into the
   * memoisation cache is a string created by concatenating dye
   * names with counts (sorted lexicographically).  For example,
   * { red:2, blue:1 } produces 'blue1_red2'.
   */
  const labMemo = new Map();

  /**
   * Build a canonical string key for a given counts object.  The
   * returned key sorts the dye names alphabetically and concatenates
   * the count only when the count is non‑zero.
   *
   * @param {object} counts mapping from dye to count
   * @returns {string} canonical key
   */
  function countsKey(counts) {
    const parts = [];
    for (const name of Object.keys(counts).sort()) {
      const c = counts[name];
      if (c && c > 0) parts.push(name + c);
    }
    return parts.join('_');
  }

  /**
   * Given a counts object, return an object containing both the RGB
   * and Lab representations of the mixed colour.  Results are
   * cached by key.  A fresh object is returned so that callers
   * cannot inadvertently mutate cached results.
   *
   * @param {object} counts mapping from dye name to count
   * @returns {{rgb:{r:number,g:number,b:number}, lab:{L:number,a:number,b:number}}}
   */
  function getMixedColour(counts) {
    const key = countsKey(counts);
    let entry = labMemo.get(key);
    if (!entry) {
      const rgb = mixCounts(counts);
      const lab = rgbToLab([rgb.r, rgb.g, rgb.b]);
      entry = { rgb, lab };
      labMemo.set(key, entry);
    }
    // return a shallow copy to prevent mutation
    return { rgb: { r: entry.rgb.r, g: entry.rgb.g, b: entry.rgb.b }, lab: { L: entry.lab.L, a: entry.lab.a, b: entry.lab.b } };
  }

  /**
   * Snap the target colour to the nearest default dye when the
   * distance falls below a threshold.  This allows the UI to
   * immediately return a perfect match when the desired colour
   * corresponds exactly to one of the base dyes or is within a
   * small perceptual distance of one.  The function returns
   * `null` when no dye is close enough.
   *
   * @param {{L:number,a:number,b:number}} targetLab target colour in Lab
   * @param {number} threshold maximum ΔE to accept as a snap
   * @returns {{name:string,rgb:{r:number,g:number,b:number},deltaE:number}}|null
   */
  function snapToDye(targetLab, threshold) {
    let closest = null;
    for (const name in dyeData) {
      const lab = dyeData[name].lab;
      const dist = deltaE(lab, targetLab);
      if (dist <= threshold) {
        if (!closest || dist < closest.deltaE) {
          closest = {
            name,
            rgb: { r: dyeData[name].r, g: dyeData[name].g, b: dyeData[name].b },
            deltaE: dist
          };
        }
      }
    }
    return closest;
  }

  /**
   * Beam search for the best dye combination to match a target.  The
   * search explores combinations up to a maximum depth.  At each
   * depth the search keeps only the top `beamWidth` candidates
   * according to their distance to the target.  Candidates with
   * distances exceeding `deltaECutoff` are discarded early.  The
   * search stops prematurely if the best distance at a given depth
   * falls below `earlyStop`.  The algorithm returns the state
   * corresponding to the best candidate found.
   *
   * A state has the following shape:
   * {
   *   counts: {dyeName:count,...},
   *   n: number of dyes used,
   *   totalR: summed red (including base),
   *   totalG: summed green,
   *   totalB: summed blue,
   *   totalMax: summed maxima,
   *   deltaE: distance to target,
   *   lab: Lab representation of the mixed colour,
   *   rgb: RGB representation of the mixed colour
   * }
   *
   * @param {{L:number,a:number,b:number}} targetLab target colour in Lab
   * @param {object} opts search parameters
   * @param {number} opts.depth maximum number of dyes
   * @param {number} opts.beamWidth maximum number of states to retain per depth
   * @param {number} opts.earlyStop distance under which to terminate the search
   * @param {number} opts.deltaECutoff prune candidates with distance above this value
   * @returns {object} best final state
   */
  function beamSearch(targetLab, opts) {
    const depth = opts.depth || 1;
    const beamWidth = opts.beamWidth || 50;
    const earlyStop = typeof opts.earlyStop === 'number' ? opts.earlyStop : 0;
    const deltaECutoff = typeof opts.deltaECutoff === 'number' ? opts.deltaECutoff : Infinity;

    // Initial state: no dyes.  Totals are zero; the resulting colour
    // is the base canvas.  n counts dyes only.
    const initState = {
      counts: {},
      n: 0,
      totalR: 0,
      totalG: 0,
      totalB: 0,
      totalMax: 0,
      rgb: { r: BASE.r, g: BASE.g, b: BASE.b },
      lab: BASE.lab,
      deltaE: deltaE(BASE.lab, targetLab)
    };
    let current = [initState];
    let best = initState;
    // At each depth, expand states by one dye
    for (let d = 1; d <= depth; d++) {
      const nextStates = [];
      for (const state of current) {
        // Expand this state by adding one of each dye
        for (const name in dyeData) {
          // Copy counts object; mutate the copy
          const newCounts = Object.assign({}, state.counts);
          newCounts[name] = (newCounts[name] || 0) + 1;
          // Update totals
          const dye = dyeData[name];
          const totalR = state.totalR + dye.r;
          const totalG = state.totalG + dye.g;
          const totalB = state.totalB + dye.b;
          const totalMax = state.totalMax + dye.max;
          const n = state.n + 1; // number of dyes used now
          // Compute average across dyes only
          const avgR = Math.floor(totalR / n);
          const avgG = Math.floor(totalG / n);
          const avgB = Math.floor(totalB / n);
          const avgMax = Math.floor(totalMax / n);
          const maxOfAvg = Math.max(avgR, avgG, avgB);
          let resR, resG, resB;
          if (maxOfAvg === 0) {
            resR = resG = resB = 0;
          } else {
            const gain = Math.floor(avgMax / maxOfAvg);
            resR = avgR * gain;
            resG = avgG * gain;
            resB = avgB * gain;
          }
          // If no dyes (n==0) then result is base
          const rgb = n === 0 ? { r: BASE.r, g: BASE.g, b: BASE.b } : { r: resR, g: resG, b: resB };
          const lab = n === 0 ? BASE.lab : rgbToLab([resR, resG, resB]);
          const dist = deltaE(lab, targetLab);
          if (dist > deltaECutoff) {
            continue;
          }
          const newState = {
            counts: newCounts,
            n: n,
            totalR: totalR,
            totalG: totalG,
            totalB: totalB,
            totalMax: totalMax,
            rgb: rgb,
            lab: lab,
            deltaE: dist
          };
          nextStates.push(newState);
          // Track best overall
          if (dist < best.deltaE) {
            best = newState;
          }
        }
      }
      if (nextStates.length === 0) {
        break;
      }
      // Sort by deltaE ascending and truncate to beam width
      nextStates.sort((a, b) => a.deltaE - b.deltaE);
      current = nextStates.slice(0, beamWidth);
      // Early stop if best is good enough
      if (best.deltaE <= earlyStop) {
        break;
      }
    }
    return best;
  }

  /**
   * Two‑stage beam search.  Splits the overall depth into two
   * sub‑searches.  First runs a beam search for `depth1` dyes,
   * retaining at most `beamWidth` candidates.  Then each candidate
   * serves as the starting point for a second beam search of
   * `depth2` dyes.  The best overall result across all second stage
   * searches is returned.  If `depth1` or `depth2` is zero the
   * corresponding phase is skipped.  This search strategy can
   * explore deeper combinations than a single beam search without
   * exploring the full combinatorial explosion.
   *
   * @param {{L:number,a:number,b:number}} targetLab target colour
   * @param {object} opts search parameters (see beamSearch)
   * @param {number} opts.depth total number of dyes
   * @param {number} opts.beamWidth beam width
   * @param {number} opts.earlyStop early stop
   * @param {number} opts.deltaECutoff distance cutoff
   * @param {number} opts.stepSplit optional explicit split point; if not supplied the split is roughly depth/2
   * @returns {object} best final state
   */
  function twoStepSearch(targetLab, opts) {
    const depth = opts.depth || 1;
    const beamWidth = opts.beamWidth || 50;
    const earlyStop = typeof opts.earlyStop === 'number' ? opts.earlyStop : 0;
    const deltaECutoff = typeof opts.deltaECutoff === 'number' ? opts.deltaECutoff : Infinity;
    let split = opts.stepSplit;
    if (typeof split !== 'number') {
      split = Math.floor(depth / 2);
    }
    const depth1 = split;
    const depth2 = depth - depth1;
    // search first stage
    const first = [];
    const initState = {
      counts: {},
      n: 0,
      totalR: 0,
      totalG: 0,
      totalB: 0,
      totalMax: 0,
      rgb: { r: BASE.r, g: BASE.g, b: BASE.b },
      lab: BASE.lab,
      deltaE: deltaE(BASE.lab, targetLab)
    };
    let current = [initState];
    let best = initState;
    // first stage expansions
    for (let d = 1; d <= depth1; d++) {
      const next = [];
      for (const state of current) {
        for (const name in dyeData) {
          const newCounts = Object.assign({}, state.counts);
          newCounts[name] = (newCounts[name] || 0) + 1;
          const dye = dyeData[name];
          const totalR = state.totalR + dye.r;
          const totalG = state.totalG + dye.g;
          const totalB = state.totalB + dye.b;
          const totalMax = state.totalMax + dye.max;
          const n = state.n + 1;
          const avgR = Math.floor(totalR / n);
          const avgG = Math.floor(totalG / n);
          const avgB = Math.floor(totalB / n);
          const avgMax = Math.floor(totalMax / n);
          const maxOfAvg = Math.max(avgR, avgG, avgB);
          let resR, resG, resB;
          if (maxOfAvg === 0) {
            resR = resG = resB = 0;
          } else {
            const gain = Math.floor(avgMax / maxOfAvg);
            resR = avgR * gain;
            resG = avgG * gain;
            resB = avgB * gain;
          }
          const rgb = n === 0 ? { r: BASE.r, g: BASE.g, b: BASE.b } : { r: resR, g: resG, b: resB };
          const lab = n === 0 ? BASE.lab : rgbToLab([resR, resG, resB]);
          const dist = deltaE(lab, targetLab);
          if (dist > deltaECutoff) continue;
          const ns = {
            counts: newCounts,
            n: n,
            totalR,
            totalG,
            totalB,
            totalMax,
            rgb,
            lab,
            deltaE: dist
          };
          next.push(ns);
          if (dist < best.deltaE) best = ns;
        }
      }
      if (next.length === 0) break;
      next.sort((a, b) => a.deltaE - b.deltaE);
      current = next.slice(0, beamWidth);
    }
    // take the top candidates for second stage
    const stage1Candidates = current;
    // if no second stage, return best from stage1
    if (depth2 <= 0 || stage1Candidates.length === 0) {
      return best;
    }
    // second stage: for each candidate, search deeper
    let overallBest = best;
    for (const seed of stage1Candidates) {
      // run a beam search from seed for depth2
      let current2 = [seed];
      let best2 = seed;
      for (let d = 1; d <= depth2; d++) {
        const next2 = [];
        for (const state of current2) {
          for (const name in dyeData) {
            const newCounts = Object.assign({}, state.counts);
            newCounts[name] = (newCounts[name] || 0) + 1;
            const dye = dyeData[name];
            const totalR = state.totalR + dye.r;
            const totalG = state.totalG + dye.g;
            const totalB = state.totalB + dye.b;
            const totalMax = state.totalMax + dye.max;
            const n = state.n + 1;
            const avgR = Math.floor(totalR / n);
            const avgG = Math.floor(totalG / n);
            const avgB = Math.floor(totalB / n);
            const avgMax = Math.floor(totalMax / n);
            const maxOfAvg = Math.max(avgR, avgG, avgB);
            let resR, resG, resB;
            if (maxOfAvg === 0) {
              resR = resG = resB = 0;
            } else {
              const gain = Math.floor(avgMax / maxOfAvg);
              resR = avgR * gain;
              resG = avgG * gain;
              resB = avgB * gain;
            }
            const rgb = n === 0 ? { r: BASE.r, g: BASE.g, b: BASE.b } : { r: resR, g: resG, b: resB };
            const lab = n === 0 ? BASE.lab : rgbToLab([resR, resG, resB]);
            const dist = deltaE(lab, targetLab);
            if (dist > deltaECutoff) continue;
            const newState = {
              counts: newCounts,
              n: n,
              totalR,
              totalG,
              totalB,
              totalMax,
              rgb,
              lab,
              deltaE: dist
            };
            next2.push(newState);
            if (dist < best2.deltaE) best2 = newState;
          }
        }
        if (next2.length === 0) break;
        next2.sort((a, b) => a.deltaE - b.deltaE);
        current2 = next2.slice(0, beamWidth);
      }
      if (best2.deltaE < overallBest.deltaE) {
        overallBest = best2;
        if (overallBest.deltaE <= earlyStop) {
          return overallBest;
        }
      }
    }
    return overallBest;
  }

  /**
   * Given a list of dye counts, build a corresponding ordered array
   * of dye names for display.  Dyes with higher counts appear
   * earlier in the array.  Within equal counts the dyes are
   * ordered alphabetically.  The returned array has length equal
   * to the total number of dyes (sum of counts).
   *
   * @param {object} counts mapping from dye to count
   * @returns {string[]} flattened list of dye names
   */
  function flattenCounts(counts) {
    const entries = Object.entries(counts).filter(([_, c]) => c > 0);
    // sort by descending count then name
    entries.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const result = [];
    for (const [name, count] of entries) {
      for (let i = 0; i < count; i++) {
        result.push(name);
      }
    }
    return result;
  }

  /**
   * Compute the incremental swatches for each step of the mixing
   * process.  Starting from the base colour the dyes in the
   * flattened sequence are added one by one and the intermediate
   * mixed colour is recorded.  The returned array therefore has
   * length equal to the number of dyes.  Each element contains
   * `{name:string,rgb:{r,g,b},lab:{L,a,b},deltaE:number}` where
   * `deltaE` is the distance to the final target (not the
   * intermediate target).  This function does not perform any
   * optimisation and is used solely for presentation.
   *
   * @param {string[]} sequence ordered list of dye names
   * @param {{L:number,a:number,b:number}} targetLab target colour
   * @returns {Array<{name:string,rgb:{r:number,g:number,b:number},deltaE:number}>}
   */
  function computeStepSwatches(sequence, targetLab) {
    const results = [];
    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalMax = 0;
    let n = 0;
    for (const name of sequence) {
      const dye = dyeData[name];
      totalR += dye.r;
      totalG += dye.g;
      totalB += dye.b;
      totalMax += dye.max;
      n += 1;
      let r, g, b;
      if (n === 0) {
        r = BASE.r;
        g = BASE.g;
        b = BASE.b;
      } else {
        const avgR = Math.floor(totalR / n);
        const avgG = Math.floor(totalG / n);
        const avgB = Math.floor(totalB / n);
        const avgMax = Math.floor(totalMax / n);
        const maxOfAvg = Math.max(avgR, avgG, avgB);
        if (maxOfAvg === 0) {
          r = g = b = 0;
        } else {
          const gain = Math.floor(avgMax / maxOfAvg);
          r = avgR * gain;
          g = avgG * gain;
          b = avgB * gain;
        }
      }
      const lab = n === 0 ? BASE.lab : rgbToLab([r, g, b]);
      const dist = deltaE(lab, targetLab);
      results.push({ name, rgb: { r, g, b }, deltaE: dist });
    }
    return results;
  }

  /**
   * Compute an IRL (real world) mixing preview for a given counts
   * object and compensation factor.  This mixing ignores the
   * brightness normalisation applied by Minecraft and instead
   * averages the linear RGB values of the base and dyes.  The
   * resulting colour is multiplied by a user supplied compensation
   * factor to restore some of the perceived brightness lost in
   * linear mixing.  The result is clamped to [0,255] on each
   * channel.
   *
   * @param {object} counts mapping from dye to count
   * @param {number} compensation brightness multiplier (>=0)
   * @returns {{r:number,g:number,b:number}} the IRL preview colour
   */
  function mixIrl(counts, compensation) {
    // Average linear RGB across dyes only.  If no dyes return the base.
    let totalLinR = 0;
    let totalLinG = 0;
    let totalLinB = 0;
    let n = 0;
    for (const name in counts) {
      const c = counts[name];
      if (c && c > 0) {
        const lin = dyeData[name].linear;
        totalLinR += lin.r * c;
        totalLinG += lin.g * c;
        totalLinB += lin.b * c;
        n += c;
      }
    }
    if (n === 0) {
      return { r: BASE.r, g: BASE.g, b: BASE.b };
    }
    const avgLinR = (totalLinR / n) * compensation;
    const avgLinG = (totalLinG / n) * compensation;
    const avgLinB = (totalLinB / n) * compensation;
    return {
      r: linearToSrgb(avgLinR),
      g: linearToSrgb(avgLinG),
      b: linearToSrgb(avgLinB)
    };
  }

  /**
   * Top level search function.  Given a target colour in hex and
   * search parameters this function optionally snaps to a single dye
   * or invokes either the beam or two step search.  The returned
   * object contains the final colour in RGB, the ΔE value, the
   * counts of each dye used, a flattened sequence for display,
   * per‑step swatches and an IRL preview colour if requested.
   *
   * @param {string} targetHex target colour in hex
   * @param {object} params search parameters
   * @param {number} params.depth number of dyes to mix
   * @param {boolean} params.twoStep whether to use two stage search
   * @param {number} params.beamWidth beam width
   * @param {number} params.earlyStop early stop threshold
   * @param {number} params.deltaECutoff prune threshold
   * @param {boolean} params.snap whether to enable snapping
   * @param {number} params.snapThreshold ΔE threshold for snapping
   * @param {boolean} params.irl whether to compute an IRL preview
   * @param {number} params.compensation brightness compensation for IRL
   * @returns {object}
   */
  function search(targetHex, params) {
    const targetRgb = hexToRgb(targetHex);
    const targetLab = rgbToLab([targetRgb.r, targetRgb.g, targetRgb.b]);
    const depth = params.depth || 1;
    const beamWidth = params.beamWidth || 50;
    const earlyStop = typeof params.earlyStop === 'number' ? params.earlyStop : 0;
    const deltaECutoff = typeof params.deltaECutoff === 'number' ? params.deltaECutoff : Infinity;
    const snapEnabled = !!params.snap;
    const snapThreshold = typeof params.snapThreshold === 'number' ? params.snapThreshold : 2;
    const irl = !!params.irl;
    const compensation = typeof params.compensation === 'number' ? params.compensation : 1;
    // Snap to dye when close enough
    if (snapEnabled) {
      const snapped = snapToDye(targetLab, snapThreshold);
      if (snapped) {
        // Build counts with a single dye but show zero steps for snapping
        const counts = {};
        counts[snapped.name] = 1;
        // No mixing steps when snapping
        const sequence = [];
        const swatches = [];
        const irlColour = irl ? mixIrl(counts, compensation) : null;
        return {
          colour: snapped.rgb,
          deltaE: snapped.deltaE,
          counts,
          sequence,
          swatches,
          irl: irlColour
        };
      }
    }
    // Choose algorithm
    let bestState;
    if (params.twoStep) {
      bestState = twoStepSearch(targetLab, { depth, beamWidth, earlyStop, deltaECutoff });
    } else {
      bestState = beamSearch(targetLab, { depth, beamWidth, earlyStop, deltaECutoff });
    }
    const counts = bestState.counts;
    const sequence = flattenCounts(counts);
    const swatches = computeStepSwatches(sequence, targetLab);
    const irlColour = irl ? mixIrl(counts, compensation) : null;
    return {
      colour: bestState.rgb,
      deltaE: bestState.deltaE,
      counts,
      sequence,
      swatches,
      irl: irlColour
    };
  }

  // Public API
  const api = {
    dyes: DYE_HEX,
    hexToRgb,
    rgbToLab,
    deltaE,
    search,
    mixCounts,
    snapToDye,
    mixIrl
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // attach to global (window) for browser usage
  if (typeof global !== 'undefined') {
    global.Mixer = api;
  }
})(typeof window !== 'undefined' ? window : global);