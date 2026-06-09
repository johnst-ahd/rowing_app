/**
 * Logic tests for native session auto-resume (screen-off / minimize / reopen).
 * Run: node scripts/test-session-resume.mjs
 */

function canAutoResume(native, persisted) {
  return (
    Boolean(native?.active && native.sessionId && native.deviceId) ||
    Boolean(persisted?.sessionId && persisted.deviceId)
  );
}

function resolveResumeCandidate(native, persisted, settingsDeviceId) {
  if (!canAutoResume(native, persisted)) {
    return { action: 'none' };
  }
  const useNative = Boolean(native?.active && native.sessionId && native.deviceId);
  const sessionId = useNative ? native.sessionId : persisted.sessionId;
  const deviceId = useNative ? native.deviceId : persisted.deviceId;
  if (settingsDeviceId.trim() !== deviceId.trim()) {
    return { action: 'mismatch', savedDeviceId: deviceId, settingsDeviceId };
  }
  return {
    action: 'resume',
    candidate: {
      sessionId,
      deviceId,
      startedAt: native?.startedAt ?? persisted?.startedAt,
      athleteId: native?.athleteId,
      serviceRunning: Boolean(native?.serviceRunning),
    },
  };
}

const cases = [
  {
    name: 'minimized — service still running, persisted in localStorage',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: 1_700_000_000_000,
    },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: 1_700_000_000_000,
    },
    settingsDeviceId: 'CREW-01',
    expect: { action: 'resume', skipNativeStart: true },
  },
  {
    name: 'service running but localStorage lost (WebView wiped)',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
    },
    persisted: null,
    settingsDeviceId: 'CREW-01',
    expect: { action: 'resume', skipNativeStart: true },
  },
  {
    name: 'phone reboot — persisted only, service not running',
    native: { active: false, serviceRunning: false },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: 1_700_000_000_000,
    },
    settingsDeviceId: 'CREW-01',
    expect: { action: 'resume', skipNativeStart: false },
  },
  {
    name: 'intentional stop — nothing persisted',
    native: { active: false, serviceRunning: false },
    persisted: null,
    settingsDeviceId: 'CREW-01',
    expect: { action: 'none' },
  },
  {
    name: 'device ID changed in settings — do not resume',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
    },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: 1,
    },
    settingsDeviceId: 'CREW-99',
    expect: { action: 'mismatch' },
  },
];

let failed = 0;
for (const c of cases) {
  const result = resolveResumeCandidate(c.native, c.persisted, c.settingsDeviceId);
  const ok =
    result.action === c.expect.action &&
    (c.expect.action !== 'resume' ||
      result.candidate.serviceRunning === c.expect.skipNativeStart);
  if (!ok) {
    failed++;
    console.error('FAIL:', c.name);
    console.error('  expected', c.expect);
    console.error('  got', result);
  } else {
    console.log('ok:', c.name);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} resume logic tests passed.`);
