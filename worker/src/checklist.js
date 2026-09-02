// Pure checklist logic: no network, no Workers APIs. Mirrors the behaviour of
// the gateway bot in ../../index.js so the two stay comparable.

export const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const CHECKLIST_TITLE = "📋 Weekly Video Checklist";

// Pinged when an editor marks THAT DAY "Edited".
export const QC_BY_DAY = {
  Monday: "&1533389121622376489",
  Tuesday: "&1533389610762375228",
  Wednesday: "&1533389665627930675",
  Thursday: "&1533389719080271963",
  Friday: "&1533389774864519279",
  Saturday: "&1533389809878306947",
};

// Pinged when QC approves or declines THAT DAY.
export const EDITOR_BY_DAY = {
  Monday: "&1533389029058547785",
  Tuesday: "&1533389275608125530",
  Wednesday: "&1533389373826138153",
  Thursday: "&1533389443283685486",
  Friday: "&1533389491824365628",
  Saturday: "&1533389549336789077",
};

export function freshState() {
  return {
    rows: DAYS_OF_WEEK.map((day) => ({
      label: day,
      qcPingId: QC_BY_DAY[day],
      editorPingId: EDITOR_BY_DAY[day],
      driveLink: null,
      edited: false,
      qcStatus: null, // null | 'complete' | 'declined'
      qcNotes: null,
    })),
  };
}

export function makeMention(pingId) {
  if (!pingId) return "";
  return pingId.startsWith("&") ? `<@&${pingId.slice(1)}>` : `<@${pingId}>`;
}

function statusLine(row) {
  if (row.qcStatus === "complete") return "✅ Edited   ✅ QC approved";
  if (row.qcStatus === "declined") return "⚠️ Changes requested — awaiting re-edit";
  if (row.edited) return "✅ Edited   ⏳ Awaiting QC";
  return "⬜ Not edited";
}

// Button styles as raw API integers: 1 primary, 2 secondary, 3 success, 4 danger.
const STYLE_SECONDARY = 2;
const STYLE_SUCCESS = 3;
const STYLE_DANGER = 4;

// State is keyed by a short id minted when the checklist is posted, and carried
// inside every custom_id. The gateway bot keyed off the message id, which it
// only learned after replying; deriving the key up front means the state can be
// written before the message exists, and survives Discord retrying a request.
export function buildChecklistPayload(state, stateId) {
  const description = state.rows
    .map((row) => {
      let block = `**${row.label}**\n${statusLine(row)}`;
      if (row.driveLink) block += `\n🔗 ${row.driveLink}`;
      if (row.qcNotes) block += `\n📝 QC notes: ${row.qcNotes}`;
      return block;
    })
    .join("\n\n");

  // Discord caps a message at 5 action rows x 5 buttons. 6 days x 3 buttons is
  // 18, so flatten and pack 5 per row (4 rows).
  const buttons = [];
  state.rows.forEach((row, rowIdx) => {
    const locked = row.qcStatus === "complete";
    const short = row.label.slice(0, 3);

    buttons.push({
      type: 2,
      custom_id: `chk_${stateId}_${rowIdx}_edited`,
      label: `${short}: Edited`,
      style: row.edited ? STYLE_SUCCESS : STYLE_SECONDARY,
      disabled: locked,
    });
    buttons.push({
      type: 2,
      custom_id: `chk_${stateId}_${rowIdx}_pass`,
      label: `${short}: QC ✓`,
      style: row.qcStatus === "complete" ? STYLE_SUCCESS : STYLE_SECONDARY,
      disabled: locked || !row.edited,
    });
    buttons.push({
      type: 2,
      custom_id: `chk_${stateId}_${rowIdx}_fail`,
      label: `${short}: QC ✗`,
      style: row.qcStatus === "declined" ? STYLE_DANGER : STYLE_SECONDARY,
      disabled: locked || !row.edited,
    });
  });

  const components = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push({ type: 1, components: buttons.slice(i, i + 5) });
  }

  return {
    embeds: [{ title: CHECKLIST_TITLE, color: 0x5865f2, description }],
    components,
  };
}
