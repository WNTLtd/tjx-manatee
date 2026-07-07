function buildMentorshipGoalEntry(authorLabel, text) {
  const note = String(text || "").trim();
  if (!note) return null;

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  return `[${timestamp}] ${authorLabel}: ${note}`;
}

function appendMentorshipGoalLog(existingLog, entry) {
  if (!existingLog) return entry;
  return `${existingLog}\n${entry}`;
}

function parseMentorshipGoalLog(goalLog) {
  return String(goalLog || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
}

function countMentorshipGoalEntries(goalLog) {
  return parseMentorshipGoalLog(goalLog).length;
}

function getMentorshipUnreadGoalCount(mentorship, userId) {
  const totalEntries = countMentorshipGoalEntries(mentorship?.goals_log);
  const seenCount = Number(
    userId === mentorship?.mentor_id
      ? mentorship?.mentor_goals_seen_count
      : userId === mentorship?.mentee_id
        ? mentorship?.mentee_goals_seen_count
        : 0
  ) || 0;

  return Math.max(totalEntries - seenCount, 0);
}

module.exports = {
  buildMentorshipGoalEntry,
  appendMentorshipGoalLog,
  countMentorshipGoalEntries,
  getMentorshipUnreadGoalCount,
  parseMentorshipGoalLog,
};