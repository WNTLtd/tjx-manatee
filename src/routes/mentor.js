const express = require("express");
const { db } = require("../db");
const { requireRole, setFlash } = require("../middleware/auth");
const { sendSystemEmail } = require("../utils/mailer");
const { escapeHtml } = require("../utils/html");
const { buildMentorshipGoalEntry, appendMentorshipGoalLog, getMentorshipUnreadGoalCount, parseMentorshipGoalLog } = require("../utils/mentorshipGoals");

const router = express.Router();
router.use(requireRole("mentor"));

function getMentorContext(userId) {
  const profile = db
    .prepare(
      `SELECT
         mp.user_id,
         mp.available,
         mp.location_id,
         l.name AS location_name,
         u.title,
         u.pronouns,
         u.first_name,
         u.surname,
         u.job_title
       FROM mentor_profiles mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN locations l ON l.id = mp.location_id
       WHERE mp.user_id = ?`
    )
    .get(userId);
  const selectedSections = db
    .prepare(
      `SELECT s.id, s.name
       FROM mentor_sections ms
       JOIN sections s ON s.id = ms.section_id
       WHERE ms.mentor_id = ?
       ORDER BY s.name`
    )
    .all(userId);
  return { profile, selectedSections };
}

router.get("/profile-setup", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const sections = db.prepare("SELECT * FROM sections ORDER BY name").all();
  const { profile, selectedSections } = getMentorContext(req.currentUser.id);

  res.render("mentor/profile-setup", {
    title: "Mentor Profile",
    locations,
    sections,
    profile,
    selectedSectionIds: selectedSections.map((s) => s.id),
  });
});

router.post("/profile", (req, res) => {
  const quickAvailability = req.body.quick_available;
  const existing = db
    .prepare(
      `SELECT u.title, u.pronouns, u.first_name, u.surname, u.job_title, mp.location_id, mp.available
       FROM users u
       JOIN mentor_profiles mp ON mp.user_id = u.id
       WHERE u.id = ?`
    )
    .get(req.currentUser.id);

  if (!existing) {
    setFlash(req, "error", "Mentor profile not found.");
    return res.redirect("/mentor");
  }

  if (quickAvailability === "1" || quickAvailability === "0") {
    db.prepare("UPDATE mentor_profiles SET available = ? WHERE user_id = ?").run(Number(quickAvailability), req.currentUser.id);
    setFlash(req, "success", `Availability set to ${quickAvailability === "1" ? "available" : "unavailable"}.`);
    return res.redirect("/mentor");
  }

  const locationId = req.body.location_id ? Number(req.body.location_id) : existing.location_id;
  const available = req.body.available === undefined ? existing.available : req.body.available === "0" ? 0 : 1;
  const title = String(req.body.title || existing.title || "").trim() || null;
  const pronouns = String(req.body.pronouns || existing.pronouns || "").trim() || null;
  const firstName = String(req.body.first_name || existing.first_name || "").trim() || null;
  const surname = String(req.body.surname || existing.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || existing.job_title || "").trim() || null;
  const sectionIds = Array.isArray(req.body.section_ids)
    ? req.body.section_ids.map(Number).filter(Boolean)
    : req.body.section_ids
      ? [Number(req.body.section_ids)]
      : [];

  const before = getMentorContext(req.currentUser.id);

  db.prepare("UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    title,
    pronouns,
    firstName,
    surname,
    jobTitle,
    req.currentUser.id
  );

  db.prepare("UPDATE mentor_profiles SET location_id = ?, available = ? WHERE user_id = ?").run(locationId, available, req.currentUser.id);
  db.prepare("DELETE FROM mentor_sections WHERE mentor_id = ?").run(req.currentUser.id);

  const insert = db.prepare("INSERT INTO mentor_sections (mentor_id, section_id) VALUES (?, ?)");
  for (const sectionId of sectionIds) insert.run(req.currentUser.id, sectionId);

  const location = locationId
    ? db.prepare("SELECT name FROM locations WHERE id = ?").get(locationId)
    : null;
  const sectionNames = sectionIds.length
    ? db
        .prepare(
          `SELECT name FROM sections WHERE id IN (${sectionIds
            .map(() => "?")
            .join(",")}) ORDER BY name`
        )
        .all(...sectionIds)
        .map((s) => s.name)
    : [];

  const isFirstProfileCompletion =
    (!before.profile?.location_id || before.selectedSections.length === 0) &&
    Boolean(locationId) &&
    sectionIds.length > 0;

  const subject = isFirstProfileCompletion
    ? "Welcome to Manatee - Mentor profile ready"
    : "Manatee mentor profile updated";

  const html = isFirstProfileCompletion
    ? `<p>Welcome to Manatee.</p><p>Your mentor profile is now active.</p><p>Location: ${location?.name || "Not set"}</p><p>Availability: ${available ? "Yes" : "No"}</p><p>Functions: ${sectionNames.join(", ") || "None"}</p>`
    : `<p>Your mentor profile has been updated.</p><p>Location: ${location?.name || "Not set"}</p><p>Availability: ${available ? "Yes" : "No"}</p><p>Functions: ${sectionNames.join(", ") || "None"}</p>`;

  const text = isFirstProfileCompletion
    ? `Welcome to Manatee. Your mentor profile is now active. Location: ${location?.name || "Not set"}. Availability: ${available ? "Yes" : "No"}. Functions: ${sectionNames.join(", ") || "None"}.`
    : `Your mentor profile has been updated. Location: ${location?.name || "Not set"}. Availability: ${available ? "Yes" : "No"}. Functions: ${sectionNames.join(", ") || "None"}.`;

  sendSystemEmail({
    to: req.currentUser.email,
    subject,
    html,
    text,
    eventType: isFirstProfileCompletion ? "mentor_profile_welcome" : "mentor_profile_updated",
    actorUserId: req.currentUser.id,
  }).catch((err) => {
    console.error("Failed to send mentor profile email", err);
  });

  setFlash(req, "success", "Mentor profile updated.");
  return res.redirect("/mentor");
});

router.get("/", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const sections = db.prepare("SELECT * FROM sections ORDER BY name").all();
  const endReasons = db.prepare("SELECT * FROM end_reasons ORDER BY name").all();
  const { profile, selectedSections } = getMentorContext(req.currentUser.id);

  const mentorships = db
    .prepare(
      `SELECT m.*, u.email AS mentee_email, s.name AS section_name, er.name AS end_reason_name
       FROM mentorships m
       JOIN users u ON u.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       LEFT JOIN end_reasons er ON er.id = m.end_reason_id
       WHERE m.mentor_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(req.currentUser.id);

  const mentorshipsWithGoalCounts = mentorships.map((mentorship) => ({
    ...mentorship,
    goalUnreadCount: getMentorshipUnreadGoalCount(mentorship, req.currentUser.id),
  }));

  res.render("mentor/index", {
    title: "Mentor Dashboard",
    locations,
    sections,
    profile,
    selectedSectionIds: selectedSections.map((s) => s.id),
    mentorships: mentorshipsWithGoalCounts,
    endReasons,
  });
});

router.get("/mentorship/:id/goals", (req, res) => {
  const mentorshipId = Number(req.params.id);
  if (!mentorshipId) {
    setFlash(req, "error", "Invalid mentorship.");
    return res.redirect("/mentor");
  }

  const mentorship = db
    .prepare(
      `SELECT
         m.*,
         mentor.email AS mentor_email,
         mentee.email AS mentee_email,
         s.name AS section_name,
         er.name AS end_reason_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       LEFT JOIN end_reasons er ON er.id = m.end_reason_id
       WHERE m.id = ? AND m.mentor_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship) {
    setFlash(req, "error", "Mentorship not found.");
    return res.redirect("/mentor");
  }

  const goalEntries = parseMentorshipGoalLog(mentorship.goals_log);
  const goalReadCount = mentorship.mentor_goals_seen_count || 0;
  if (goalReadCount !== goalEntries.length) {
    db.prepare("UPDATE mentorships SET mentor_goals_seen_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(goalEntries.length, mentorship.id);
    mentorship.mentor_goals_seen_count = goalEntries.length;
  }

  return res.render("mentorship-goals", {
    title: "Mentorship Goals",
    backHref: "/mentor",
    backLabel: "Mentor Dashboard",
    pageHeading: "Mentorship Goals",
    pageSubheading: `${mentorship.mentee_email} ${mentorship.section_name ? `• ${mentorship.section_name}` : ""}`.trim(),
    mentorship,
    goalEntries,
    entryLabel: "Mentor",
    submitAction: `/mentor/mentorship/${mentorship.id}/goals`,
    canAppend: ["pending", "accepted"].includes(mentorship.status),
  });
});

router.post("/mentorship/:id/respond", async (req, res) => {
  const mentorshipId = Number(req.params.id);
  const action = String(req.body.action || "");
  const mentorMessage = String(req.body.mentor_message || "").trim();

  if (!["accepted", "declined"].includes(action)) {
    setFlash(req, "error", "Invalid action.");
    return res.redirect("/mentor");
  }

  const mentorship = db
    .prepare(
      `SELECT m.*, mu.email AS mentee_email
       FROM mentorships m
       JOIN users mu ON mu.id = m.mentee_id
       WHERE m.id = ? AND m.mentor_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship || mentorship.status !== "pending") {
    setFlash(req, "error", "Mentorship request not found or no longer pending.");
    return res.redirect("/mentor");
  }

  db.prepare("UPDATE mentorships SET status = ?, mentor_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(action, mentorMessage || null, mentorshipId);

  const verb = action === "accepted" ? "accepted" : "declined";
  try {
    await sendSystemEmail({
      to: mentorship.mentee_email,
      subject: `Manatee mentorship ${verb}`,
      html: `<p>Your mentorship request was ${verb} by your mentor.</p><p>Message: ${mentorMessage || "No message provided."}</p>`,
      text: `Your mentorship request was ${verb}. Message: ${mentorMessage || "No message provided."}`,
      eventType: action === "accepted" ? "mentor_accepted_request" : "mentor_declined_request",
      actorUserId: req.currentUser.id,
    });
  } catch (err) {
    console.error("Failed to send mentee response email", err);
  }

  setFlash(req, "success", `Mentorship ${verb}.`);
  return res.redirect("/mentor");
});

router.post("/mentorship/:id/end", async (req, res) => {
  const mentorshipId = Number(req.params.id);
  const endReasonId = req.body.end_reason_id ? Number(req.body.end_reason_id) : null;

  const mentorship = db
    .prepare(
      `SELECT m.*, mu.email AS mentee_email
       FROM mentorships m
       JOIN users mu ON mu.id = m.mentee_id
       WHERE m.id = ? AND m.mentor_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship || mentorship.status !== "accepted") {
    setFlash(req, "error", "Only live mentorships can be ended.");
    return res.redirect("/mentor");
  }

  db.prepare(
    `UPDATE mentorships
     SET status='ended', end_reason_id=?, ended_by_user_id=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(endReasonId, req.currentUser.id, mentorshipId);

  try {
    await sendSystemEmail({
      to: mentorship.mentee_email,
      subject: "Manatee mentorship ended",
      html: "<p>Your mentorship has been marked as ended by your mentor.</p>",
      text: "Your mentorship has been marked as ended by your mentor.",
      eventType: "mentor_ended_mentorship",
      actorUserId: req.currentUser.id,
    });
  } catch (err) {
    console.error("Failed to send mentorship ended email", err);
  }

  setFlash(req, "success", "Mentorship ended.");
  return res.redirect("/mentor");
});

router.post("/mentorship/:id/goals", (req, res) => {
  const mentorshipId = Number(req.params.id);
  const goalText = String(req.body.goal_entry || "").trim();

  if (!goalText) {
    setFlash(req, "error", "Please enter a goal or next step.");
    return res.redirect(`/mentor/mentorship/${mentorshipId}/goals`);
  }

  const mentorship = db
    .prepare(
      `SELECT m.id, m.status, m.goals_log, m.mentor_goals_seen_count, mentee.email AS mentee_email, s.name AS section_name
       FROM mentorships m
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.id = ? AND m.mentor_id = ? AND m.status IN ('pending', 'accepted')`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship) {
    setFlash(req, "error", "Mentorship not found or no longer editable.");
    return res.redirect(`/mentor/mentorship/${mentorshipId}/goals`);
  }

  const entry = buildMentorshipGoalEntry("Mentor", goalText);
  const updatedLog = appendMentorshipGoalLog(mentorship.goals_log, entry);
  const updatedGoalCount = parseMentorshipGoalLog(updatedLog).length;

  db.prepare("UPDATE mentorships SET goals_log = ?, mentor_goals_seen_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    updatedLog,
    updatedGoalCount,
    mentorshipId
  );

  sendSystemEmail({
    to: mentorship.mentee_email,
    subject: "A new msg from your Mentor has been submitted.",
    html: `<p>A new next step record was added by your mentor.</p><p><strong>Entry:</strong></p><p>${escapeHtml(goalText).replace(/\n/g, "<br />")}</p><p><a href="${req.protocol}://${req.get("host")}/mentee/mentorship/${mentorshipId}/goals">Open the goals page</a></p>`,
    text: `A new next step record was added by your mentor. Entry: ${goalText}. Open the goals page: ${req.protocol}://${req.get("host")}/mentee/mentorship/${mentorshipId}/goals`,
    eventType: "mentor_goal_entry_added",
    actorUserId: req.currentUser.id,
  }).catch((err) => {
    console.error("Failed to send mentor goal entry email", err);
  });

  setFlash(req, "success", "Goal updated.");
  return res.redirect(`/mentor/mentorship/${mentorshipId}/goals`);
});

module.exports = router;
