# GirthyCatboy’s Colour Mixer for Joy of Painting

This project implements a web based colour mixing tool designed for the **Joy of Painting** (JoP) Minecraft mod.  It reproduces the mod’s in‑game dye mixing behaviour and provides an interactive interface to approximate arbitrary target colours using combinations of the sixteen vanilla dyes.

## Background

Minecraft leather armour dyeing – and by extension the JoP canvas – mixes colours using a specific averaging algorithm.  Each colour contributes its red, green and blue channels as well as the maximum of those channels.  These values are averaged across all participants (including the base canvas) using integer division.  The average channels are then scaled by the ratio of the average of maxima to the maximum of the averages.  This brightness normalisation keeps the result close in luminance to the inputs.  The code in `mixing.js` follows the implementation found in the JoP source (`PaletteUtil.java`) exactly【163091501191625†L38-L60】.

For example, mixing a white base with two dyes yields:

```
totalR = baseR + dye1R + dye2R
totalG = baseG + dye1G + dye2G
totalB = baseB + dye1B + dye2B
totalMax = baseMax + max(dye1) + max(dye2)
avgR = floor(totalR / 3)
avgG = floor(totalG / 3)
avgB = floor(totalB / 3)
avgMax = floor(totalMax / 3)
gain  = floor(avgMax / max(avgR,avgG,avgB))
resultR = avgR * gain
resultG = avgG * gain
resultB = avgB * gain
```

This algorithm matches both vanilla leather armour dyeing and the JoP canvas.  The mod uses a white canvas (`#FFFFFF`) rather than the leather armour base colour; the dye definitions supplied in `mixing.js` were measured directly on a JoP canvas and therefore include any subtle offsets introduced by the mod.

## Features

- **Accurate mixing model:** The core mixing logic replicates the vanilla dye algorithm, including integer rounding and brightness normalisation【163091501191625†L38-L60】.
- **Beam search:** To find a combination of dyes that matches a target colour the tool performs a beam search.  You can control the maximum number of dyes, the beam width, an early stop threshold and a ΔE cutoff.
- **Two‑step search:** Optionally split the search into two phases to explore deeper combinations without a full combinatorial explosion.
- **Snapping:** When the target is within a configurable ΔE of a single dye the tool snaps to that dye and shows zero mixing steps.
- **IRL mode:** Preview what the mixture would look like when blending real pigments.  This mode ignores the in‑game brightness normalisation and averages the linear RGB values.  A brightness compensation slider is provided to adjust for the darker appearance of linear mixing.
- **Memoisation:** Mixed colours are cached by a multiset key so repeated combinations are computed only once.
- **Test harness:** Automated tests verify that exact dye inputs snap correctly (ΔE = 0) and that a panel of ten colours can be matched within ΔE ≤ 5 using default settings.

## Getting Started

1. Open `index.html` in a modern web browser.  The page displays controls for choosing a target colour, search parameters and optional IRL mode.  Click **Mix!** to compute the best match.
2. Adjust **Max Dyes** to control how many dyes the search may use.  Higher values explore a larger space but may take longer.
3. **Beam Width** determines how many candidate mixtures are kept after each layer of the search.  Narrow widths are fast but might miss good solutions.
4. **Early Stop ΔE** causes the search to terminate early when a candidate is found below this distance.  Setting it to `0` means the search will explore all depths.
5. **ΔE Cutoff** prunes candidates above this threshold.  Lowering this value accelerates the search at the risk of missing a solution.
6. Enable **Two‑step search** to split the search into two phases.  This is useful for deep searches (e.g. 5 or 6 dyes) where a single beam search would otherwise explore too many states.
7. Turn on **Snap to nearest dye** to automatically return a dye colour when the target lies within a small ΔE of it.  Adjust the **Snap Threshold** to control the sensitivity.
8. Check **IRL mode** to see a linear light preview of the mixture.  Use the **Brightness Compensation** slider to brighten or darken the preview.

## Running Tests

The automated tests can be executed with Node.js:

```bash
node test.js
```

The test suite performs two checks:

1. **Snapping:** Each of the sixteen dye colours is passed into the search with a very small snap threshold.  The result must have zero mixing steps and a ΔE of zero.
2. **Colour panel:** Ten representative colours covering primary and secondary hues are mixed with the default search parameters.  The resulting ΔE must not exceed 5.

A manual **test card** is also provided.  Open `test_card.html` to visualise the results of mixing the same set of ten colours.

## Notes on JoP Source

Reviewing the JoP source code (specifically `PaletteUtil.java`) confirmed that the mod implements the same colour mixing algorithm as vanilla leather dyeing.  Colours are mixed by averaging the RGB components and the per‑colour maxima and then normalising the result by the ratio of these values【163091501191625†L38-L60】.  All calculations use integer division, meaning that order does not matter and the base canvas is considered one of the colours.  No further quirks were observed.

## License

This project is provided for demonstration purposes and carries no license.  Feel free to modify and experiment with the code to suit your needs.