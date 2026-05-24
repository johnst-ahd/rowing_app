'use strict';

const { MotionAnalyzer, analyzeMotionWindow } = require('../packages/motion-analysis');

function synthStrokeSamples(spm, seconds, hz) {
  const intervalMs = 60000 / spm;
  const samples = [];
  const n = Math.floor(seconds * hz);
  for (let i = 0; i < n; i++) {
    const t = i * (1000 / hz);
    const phase = (t % intervalMs) / intervalMs;
    const surge = phase < 0.15 ? 2.5 : -0.2;
    samples.push({
      t,
      motion: { ax: surge, ay: 0.1, az: 9.81 },
    });
  }
  return samples;
}

const strokeSamples = synthStrokeSamples(24, 8, 20);
const stroke = analyzeMotionWindow(strokeSamples);
console.log('Stroke test (expect ~24 spm):', stroke.strokeRate);

const capsize = new MotionAnalyzer();
for (let i = 0; i < 50; i++) {
  capsize.process(i * 50, 0, 0, 9.81);
}
for (let i = 0; i < 20; i++) {
  capsize.process(2500 + i * 50, 0, 0, -9.5);
}
console.log('Capsize test (expect true):', capsize.getMetrics().capsize);

if (stroke.strokeRate == null || stroke.strokeRate < 20 || stroke.strokeRate > 28) {
  console.error('Stroke rate out of expected range');
  process.exit(1);
}
if (!capsize.getMetrics().capsize) {
  console.error('Capsize not detected');
  process.exit(1);
}
console.log('motion-analysis OK');
