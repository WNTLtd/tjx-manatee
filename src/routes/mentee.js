const express = require("express");
const { db } = require("../db");
const { requireRole, setFlash } = require("../middleware/auth");
const { sendSystemEmail } = require("../utils/mailer");

const router = express.Router();
router.use(requireRole("mentee"));

function getMenteeProfile(userId) {
  return db
    .prepare(
      `SELECT
         mp.user_id,
         mp.location_id,
         l.name AS location_name,
         u.title,
         u.pronouns,
         u.first_name,
         u.surname,
         u.job_title
       FROM mentee_profiles mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN locations l ON l.id = mp.location_id
       WHERE mp.user_id = ?`
    )
    .get(userId);
}

router.get("/profile-setup", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const profile = getMenteeProfile(req.currentUser.id);

  res.render("mentee/profile-setup", {
    title: "Mentee Profile",
    locations,
    profile,
  });
});

router.post("/profile", (req, res) => {
  const locationId = req.body.location_id ? Number(req.body.location_id) : null;
  const title = String(req.body.title || "").trim() || null;
  const pronouns = String(req.body.pronouns || "").trim() || null;
  if (!pronouns) {
    setFlash(req, "error", "Please select your pronouns.");
    return res.redirect("/mentee/profile-setup");
  }
  const firstName = String(req.body.first_name || "").trim() || null;
  const surname = String(req.body.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || "").trim() || null;
  const before = getMenteeProfile(req.currentUser.id);

  db.prepare("UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    title,
    pronouns,
    firstName,
    surname,
    jobTitle,
    req.currentUser.id
  );

  db.prepare("UPDATE mentee_profiles SET location_id = ? WHERE user_id = ?").run(locationId, req.currentUser.id);

  const location = locationId
    ? db.prepare("SELECT name FROM locations WHERE id = ?").get(locationId)
    : null;

  const isFirstProfileCompletion = !before?.location_id && Boolean(locationId);
  const subject = isFirstProfileCompletion
    ? "Welcome to Manatee - Mentee profile ready"
    : "Manatee mentee profile updated";
  const html = isFirstProfileCompletion
    ? `<p>Welcome to Manatee.</p><p>Your mentee profile is now active.</p><p>Location: ${location?.name || "Not set"}</p>`
    : `<p>Your mentee profile has been updated.</p><p>Location: ${location?.name || "Not set"}</p>`;
  const text = isFirstProfileCompletion
    ? `Welcome to Manatee. Your mentee profile is now active. Location: ${location?.name || "Not set"}.`
    : `Your mentee profile has been updated. Location: ${location?.name || "Not set"}.`;

  sendSystemEmail({
    to: req.currentUser.email,
    subject,
    html,
    text,
    eventType: isFirstProfileCompletion ? "mentee_profile_welcome" : "mentee_profile_updated",
    actorUserId: req.currentUser.id,
  }).catch((err) => {
    console.error("Failed to send mentee profile email", err);
  });

  setFlash(req, "success", "Mentee profile updated.");
  return res.redirect("/mentee");
});

router.get("/", (req, res) => {
  const profile = getMenteeProfile(req.currentUser.id);
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const sections = db.prepare("SELECT * FROM sections ORDER BY name").all();
  const endReasons = db.prepare("SELECT * FROM end_reasons ORDER BY name").all();
  const selectedSectionId = req.query.section_id ? Number(req.query.section_id) : null;

  let availableMentors = [];
  if (profile?.location_id && selectedSectionId) {
    availableMentors = db
      .prepare(
        `SELECT u.id, u.email, l.name AS location_name
         FROM users u
         JOIN mentor_profiles mp ON mp.user_id = u.id
         JOIN mentor_sections ms ON ms.mentor_id = u.id
         LEFT JOIN locations l ON l.id = mp.location_id
         WHERE u.role IN ('mentor', 'both')
           AND mp.available=1
           AND mp.location_id = ?
           AND ms.section_id = ?
         ORDER BY u.email`
      )
      .all(profile.location_id, selectedSectionId);
  }

  const mentorships = db
    .prepare(
      `SELECT m.*, u.email AS mentor_email, s.name AS section_name, er.name AS end_reason_name
       FROM mentorships m
       JOIN users u ON u.id = m.mentor_id
       LEFT JOIN sections s ON s.id = m.section_id
       LEFT JOIN end_reasons er ON er.id = m.end_reason_id
       WHERE m.mentee_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(req.currentUser.id);

  res.render("mentee/index", {
    title: "Mentee Dashboard",
    profile,
    locations,
    sections,
    mentorships,
    availableMentors,
    selectedSectionId,
    endReasons,
  });
});

router.post("/request-mentor", async (req, res) => {
  const mentorId = Number(req.body.mentor_id);
  const sectionId = Number(req.body.section_id);
  const profile = getMenteeProfile(req.currentUser.id);

  if (!profile?.location_id) {
    setFlash(req, "error", "Please set your location first.");
    return res.redirect("/mentee");
  }

  const mentor = db
    .prepare(
      `SELECT u.id, u.email
       FROM users u
       JOIN mentor_profiles mp ON mp.user_id = u.id
       JOIN mentor_sections ms ON ms.mentor_id = u.id
       WHERE u.id = ?
         AND u.role IN ('mentor', 'both')
         AND mp.available=1
         AND mp.location_id = ?
         AND ms.section_id = ?`
    )
    .get(mentorId, profile.location_id, sectionId);

  if (!mentor) {
    setFlash(req, "error", "Selected mentor is no longer available for this location/function.");
    return res.redirect(`/mentee?section_id=${sectionId}`);
  }

  const existing = db
    .prepare(
      `SELECT id FROM mentorships
       WHERE mentor_id = ? AND mentee_id = ? AND section_id = ? AND status IN ('pending', 'accepted')`
    )
    .get(mentorId, req.currentUser.id, sectionId);

  if (existing) {
    setFlash(req, "error", "You already have a pending/live mentorship with this mentor in this function.");
    return res.redirect(`/mentee?section_id=${sectionId}`);
  }

  const inserted = db
    .prepare(
      `INSERT INTO mentorships (mentor_id, mentee_id, section_id, status)
       VALUES (?, ?, ?, 'pending')`
    )
    .run(mentorId, req.currentUser.id, sectionId);

  const section = db.prepare("SELECT name FROM sections WHERE id = ?").get(sectionId);
  const base = process.env.BASE_URL || "http://localhost:3000";
  const actionLink = `${base}/mentor`;

  try {
    await sendSystemEmail({
      to: mentor.email,
      subject: "New mentorship request in Manatee",
      html: `<p>You have a new mentorship request.</p><p>Function: ${section?.name || "N/A"}</p><p><a href=\"${actionLink}\">Review request</a></p><p>Request ID: ${inserted.lastInsertRowid}</p>`,
      text: `You have a new mentorship request. Function: ${section?.name || "N/A"}. Review: ${actionLink} (Request ID: ${inserted.lastInsertRowid})`,
      eventType: "mentee_requested_mentor",
      actorUserId: req.currentUser.id,
    });
  } catch (err) {
    console.error("Failed to send mentor request email", err);
  }

  setFlash(req, "success", "Mentorship request sent to mentor.");
  return res.redirect(`/mentee?section_id=${sectionId}`);
});

router.post("/mentorship/:id/resend", async (req, res) => {
  const mentorshipId = Number(req.params.id);
  const mentorship = db
    .prepare(
      `SELECT m.*, mu.email AS mentor_email, s.name AS section_name
       FROM mentorships m
       JOIN users mu ON mu.id = m.mentor_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.id = ? AND m.mentee_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship || mentorship.status !== "pending") {
    setFlash(req, "error", "Only pending requests can be resent.");
    return res.redirect("/mentee");
  }

  const base = process.env.BASE_URL || "http://localhost:3000";
  const actionLink = `${base}/mentor`;
  try {
    await sendSystemEmail({
      to: mentorship.mentor_email,
      subject: "Reminder: mentorship request in Manatee",
      html: `<p>You have a pending mentorship request.</p><p>Function: ${mentorship.section_name || "N/A"}</p><p><a href=\"${actionLink}\">Review request</a></p><p>Request ID: ${mentorship.id}</p>`,
      text: `You have a pending mentorship request. Function: ${mentorship.section_name || "N/A"}. Review: ${actionLink} (Request ID: ${mentorship.id})`,
      eventType: "mentee_resend_pending_request",
      actorUserId: req.currentUser.id,
    });
    setFlash(req, "success", "Reminder sent to mentor.");
  } catch (err) {
    setFlash(req, "error", `Failed to resend request: ${String(err?.message || err)}`);
  }

  return res.redirect("/mentee");
});

router.post("/mentorship/:id/cancel", (req, res) => {
  const mentorshipId = Number(req.params.id);
  const mentorship = db
    .prepare(
      `SELECT id, status
       FROM mentorships
       WHERE id = ? AND mentee_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship || mentorship.status !== "pending") {
    setFlash(req, "error", "Only pending requests can be removed.");
    return res.redirect("/mentee");
  }

  const details = db
    .prepare(
      `SELECT
         m.id,
         mentor.email AS mentor_email,
         mentee.email AS mentee_email,
         s.name AS section_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.id = ?`
    )
    .get(mentorshipId);

  db.prepare("DELETE FROM mentorships WHERE id = ?").run(mentorshipId);

  if (details?.mentor_email) {
    sendSystemEmail({
      to: details.mentor_email,
      subject: "Manatee mentorship request cancelled",
      html: `<p>The mentee has cancelled their pending mentorship request.</p><p>Mentee: ${details.mentee_email || "N/A"}</p><p>Function: ${details.section_name || "N/A"}</p><p>Request ID: ${details.id}</p>`,
      text: `The mentee has cancelled their pending mentorship request. Mentee: ${details.mentee_email || "N/A"}. Function: ${details.section_name || "N/A"}. Request ID: ${details.id}.`,
      eventType: "mentee_cancel_pending_request",
      actorUserId: req.currentUser.id,
    }).catch((err) => {
      console.error("Failed to send cancel request email", err);
    });
  }

  setFlash(req, "success", "Pending mentor request removed.");
  return res.redirect("/mentee");
});

router.post("/mentorship/:id/end", async (req, res) => {
  const mentorshipId = Number(req.params.id);
  const endReasonId = req.body.end_reason_id ? Number(req.body.end_reason_id) : null;

  const mentorship = db
    .prepare(
      `SELECT m.*, mu.email AS mentor_email
       FROM mentorships m
       JOIN users mu ON mu.id = m.mentor_id
       WHERE m.id = ? AND m.mentee_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship || mentorship.status !== "accepted") {
    setFlash(req, "error", "Only live mentorships can be ended.");
    return res.redirect("/mentee");
  }

  db.prepare(
    `UPDATE mentorships
     SET status='ended', end_reason_id=?, ended_by_user_id=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(endReasonId, req.currentUser.id, mentorshipId);

  try {
    await sendSystemEmail({
      to: mentorship.mentor_email,
      subject: "Manatee mentorship ended",
      html: "<p>Your mentorship has been marked as ended by your mentee.</p>",
      text: "Your mentorship has been marked as ended by your mentee.",
      eventType: "mentee_ended_mentorship",
      actorUserId: req.currentUser.id,
    });
  } catch (err) {
    console.error("Failed to send mentor end email", err);
  }

  setFlash(req, "success", "Mentorship ended.");
  return res.redirect("/mentee");
});

module.exports = router;
