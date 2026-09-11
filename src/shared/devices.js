// Which audio input carries the meeting's system audio when the user has not
// picked one ("Automatic"). Pure — the renderer passes the enumerated inputs.
//
// macOS labels every virtual device "(Virtual)", including the ones meeting
// apps install for their own screen-share audio (Microsoft Teams Audio, Zoom
// Audio Device…). Those never carry the call for us, so known loopback
// drivers win, other virtual devices come next, and meeting-app devices are
// skipped altogether.

const LOOPBACK_DRIVER = /blackhole|loopback|soundflower|vb-?audio|vb-?cable|copilot|monitor/i;
const MEETING_APP = /teams|zoom|webex|meet\b|skype|discord|slack|facetime/i;
const GENERIC_VIRTUAL = /virtual/i;

/**
 * @param {{ deviceId: string, label: string }[]} inputs  audio inputs, as enumerated
 * @returns the input to capture, or null when nothing looks like a loopback
 */
export function pickSystemAudioInput(inputs = []) {
  const usable = inputs.filter((d) => d.label && !MEETING_APP.test(d.label));
  return usable.find((d) => LOOPBACK_DRIVER.test(d.label)) || usable.find((d) => GENERIC_VIRTUAL.test(d.label)) || null;
}
