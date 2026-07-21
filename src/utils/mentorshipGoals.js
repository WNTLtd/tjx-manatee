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

function getMentorshipUnreadGoalCount(mentorship, userId, db = null) {
  // If no database provided, use the old logic (for backward compatibility)
  if (!db) {
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

  // Count entries from the OTHER user (not the current user)
  const otherUserId = userId === mentorship?.mentor_id
    ? mentorship?.mentee_id
    : userId === mentorship?.mentee_id
      ? mentorship?.mentor_id
      : null;

  if (!otherUserId) return 0;

  // Count entries created by the OTHER user
  const entriesFromOtherUser = db
    .prepare(
      `SELECT COUNT(*) as count FROM goal_entries 
       WHERE mentorship_id = ? AND user_id = ?`
    )
    .get(mentorship?.id, otherUserId);

  const totalEntriesFromOther = entriesFromOtherUser?.count || 0;
  
  const seenCount = Number(
    userId === mentorship?.mentor_id
      ? mentorship?.mentor_goals_seen_count
      : userId === mentorship?.mentee_id
        ? mentorship?.mentee_goals_seen_count
        : 0
  ) || 0;

  return Math.max(totalEntriesFromOther - seenCount, 0);
}

module.exports = {
  buildMentorshipGoalEntry,
  appendMentorshipGoalLog,
  countMentorshipGoalEntries,
  getMentorshipUnreadGoalCount,
  parseMentorshipGoalLog,
};