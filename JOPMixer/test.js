// test.js
// Automated tests for the Joy of Painting colour mixer.  To run
// these tests execute `node test.js` from the repository root.  The
// tests rely solely on Node's built in assert module and do not
// require any external dependencies.

const assert = require('assert');
const Mixer = require('./mixing.js');

// Helper to format RGB to hex
function rgbToHex(rgb) {
  return (
    '#' +
    [rgb.r, rgb.g, rgb.b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

// 1. Verify that snapping returns zero steps and zero Delta E for
// exact dye colours.  We deliberately set the snap threshold low
// (0.1) to force the snap logic.
function testSnapping() {
  console.log('Running snapping tests...');
  const dyes = Mixer.dyes;
  for (const name in dyes) {
    const hex = '#' + dyes[name];
    const res = Mixer.search(hex, {
      depth: 1,
      beamWidth: 10,
      earlyStop: 0,
      deltaECutoff: 10,
      snap: true,
      snapThreshold: 0.1,
      twoStep: false,
      irl: false
    });
    assert.strictEqual(res.sequence.length, 0, `Snap result for ${name} should have zero steps`);
    const outHex = rgbToHex(res.colour);
    assert.strictEqual(outHex, hex.toUpperCase(), `Snap result for ${name} should equal the target hex`);
    assert.ok(Math.abs(res.deltaE) < 1e-6, `ΔE for ${name} should be zero, got ${res.deltaE}`);
  }
  console.log('Snapping tests passed.');
}

// 2. Mix a panel of target colours and ensure the Delta E of the
// result is within a reasonable tolerance.  The colours span
// primaries and some secondary hues.  Using default parameters
// should yield matches within around 5 ΔE units.
function testPanel() {
  console.log('Running panel tests...');
  const targets = [
    '#AE2D26', // red
    '#FBD53C', // yellow
    '#5D7B16', // green
    '#3B43A8', // blue
    '#8731B6', // purple
    '#169A9A', // cyan
    '#F67E1D', // orange
    '#F089A8', // pink
    '#39B1D7', // light blue
    '#7EC51F' // lime
  ];
  targets.forEach((hex) => {
    const res = Mixer.search(hex, {
      depth: 3,
      beamWidth: 50,
      earlyStop: 0,
      deltaECutoff: Infinity,
      snap: false,
      twoStep: false,
      irl: false
    });
    assert.ok(
      res.deltaE <= 5,
      `Target ${hex} should be matched within ΔE <=5, got ${res.deltaE.toFixed(2)}`
    );
  });
  console.log('Panel tests passed.');
}

function runTests() {
  testSnapping();
  testPanel();
  console.log('All tests passed.');
}

runTests();