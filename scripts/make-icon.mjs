// Generates BEV's app icon: a dark rounded tile with a cyan→violet voice
// waveform. Renders the SVG to a 1024px master PNG via sharp; feed it to
// `tauri icon` to produce every platform size + the .ico.
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const S = 1024;

// Five rounded bars in a voice-pulse rhythm, centred.
const barW = 96;
const gap = 52;
const heights = [300, 520, 680, 460, 340];
const totalW = heights.length * barW + (heights.length - 1) * gap;
const startX = (S - totalW) / 2;
const cy = S / 2;

const bars = heights
  .map((h, i) => {
    const x = startX + i * (barW + gap);
    const y = cy - h / 2;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${barW / 2}" fill="url(#wave)"/>`;
  })
  .join("\n    ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${S}" y2="${S}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0d1526"/>
      <stop offset="1" stop-color="#05070d"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="140" x2="0" y2="884" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#38e8ff"/>
      <stop offset="0.5" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="${S}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#38e8ff" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#22d3ee" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#8b5cf6" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="${S - 16}" height="${S - 16}" rx="232" fill="url(#bg)"/>
  <rect x="12" y="12" width="${S - 24}" height="${S - 24}" rx="226" fill="none" stroke="url(#rim)" stroke-width="10"/>
  <g>
    ${bars}
  </g>
</svg>`;

writeFileSync(new URL("../logo.svg", import.meta.url), svg);

await sharp(Buffer.from(svg)).png().toFile(new URL("../logo.png", import.meta.url).pathname.replace(/^\//, ""));
console.log("wrote logo.png (1024) + logo.svg");
