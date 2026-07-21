const express = require("express");
const { db } = require("../db");
const { requireRole, setFlash } = require("../middleware/auth");
const { sendSystemEmail, getAppBaseUrl } = require("../utils/mailer");
const { escapeHtml } = require("../utils/html");
const { buildMentorshipGoalEntry, appendMentorshipGoalLog, getMentorshipUnreadGoalCount, parseMentorshipGoalLog } = require("../utils/mentorshipGoals");
const { upload, deleteUploadedFile, getStoragePath } = require("../utils/fileUpload");

const router = express.Router();
router.use(requireRole("mentee"));

// Middleware wrapper to handle multer errors gracefully
const uploadWithErrorHandling = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const mentorshipId = Number(req.params.id);
      setFlash(req, "error", "Invalid file type. Only PDF, JPG, DOC, and DOCX files are allowed.");
      return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
    }
    next();
  });
};

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
         u.job_title,
         u.phone
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
  const firstName = String(req.body.first_name || "").trim() || null;
  const surname = String(req.body.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || "").trim() || null;
  const phone = String(req.body.phone || "").trim() || null;
  const before = getMenteeProfile(req.currentUser.id);

  db.prepare("UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    title,
    pronouns,
    firstName,
    surname,
    jobTitle,
    phone,
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
  
  // If called from goals page, redirect back to it
  if (req.body.mentorship_id) {
    return res.redirect(`/mentee/mentorship/${req.body.mentorship_id}/goals`);
  }
  
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
        `SELECT u.id, u.email, u.title, u.first_name, u.surname, l.name AS location_name
         FROM users u
         JOIN mentor_profiles mp ON mp.user_id = u.id
         JOIN mentor_sections ms ON ms.mentor_id = u.id
         LEFT JOIN locations l ON l.id = mp.location_id
         WHERE u.role IN ('mentor', 'both')
           AND mp.available=1
           AND mp.location_id = ?
           AND ms.section_id = ?
         ORDER BY u.id DESC`
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

  const mentorshipsWithGoalCounts = mentorships.map((mentorship) => ({
    ...mentorship,
    goalUnreadCount: getMentorshipUnreadGoalCount(mentorship, req.currentUser.id, db),
  }));

  res.render("mentee/index", {
    title: "Mentee Dashboard",
    profile,
    locations,
    sections,
    mentorships: mentorshipsWithGoalCounts,
    availableMentors,
    selectedSectionId,
    endReasons,
  });
});

router.get("/mentorship/:id/goals", (req, res) => {
  const mentorshipId = Number(req.params.id);
  if (!mentorshipId) {
    setFlash(req, "error", "Invalid mentorship.");
    return res.redirect("/mentee");
  }

  const mentorship = db
    .prepare(
      `SELECT
         m.*,
         mentor.email AS mentor_email,
         mentor.title AS mentor_title,
         mentor.first_name AS mentor_first_name,
         mentor.surname AS mentor_surname,
         mentor.phone AS mentor_phone,
         mentee.email AS mentee_email,
         mentee.title AS mentee_title,
         mentee.first_name AS mentee_first_name,
         mentee.surname AS mentee_surname,
         mentee.phone AS mentee_phone,
         s.name AS section_name,
         er.name AS end_reason_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       LEFT JOIN end_reasons er ON er.id = m.end_reason_id
       WHERE m.id = ? AND m.mentee_id = ?`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship) {
    setFlash(req, "error", "Mentorship not found.");
    return res.redirect("/mentee");
  }

  // Mark all MENTOR entries as seen
  const mentorEntries = db
    .prepare(
      `SELECT COUNT(*) as count FROM goal_entries 
       WHERE mentorship_id = ? AND user_id = ?`
    )
    .get(mentorshipId, mentorship.mentor_id);
  
  const mentorEntryCount = mentorEntries?.count || 0;
  db.prepare("UPDATE mentorships SET mentee_goals_seen_count = ? WHERE id = ?").run(
    mentorEntryCount,
    mentorshipId
  );

  // Fetch goal entries from new table
  const entries = db
    .prepare(
      `SELECT ge.id, ge.user_id, ge.type, ge.content, ge.file_path, ge.file_name, ge.created_at, 
              u.email, u.first_name, u.surname, u.title
       FROM goal_entries ge
       JOIN users u ON u.id = ge.user_id
       WHERE ge.mentorship_id = ?
       ORDER BY ge.created_at DESC`
    )
    .all(mentorshipId);

  return res.render("mentorship-goals", {
    title: "Mentorship Goals",
    backHref: "/mentee",
    backLabel: "Mentee Dashboard",
    pageHeading: "Mentorship Goals",
    pageSubheading: `${mentorship.mentor_email} ${mentorship.section_name ? `• ${mentorship.section_name}` : ""}`.trim(),
    mentorship,
    entries,
    entryLabel: "Mentee",
    submitAction: `/mentee/mentorship/${mentorship.id}/goals`,
    canAppend: ["pending", "accepted"].includes(mentorship.status),
    isFromMentor: false,
    isFromMentee: true,
    currentUserId: req.currentUser.id,
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
  const base = getAppBaseUrl();
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

  const base = getAppBaseUrl();
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

router.post("/mentorship/:id/goals", uploadWithErrorHandling, (req, res) => {
  const mentorshipId = Number(req.params.id);
  const goalText = String(req.body.goal_entry || "").trim();
  const entryType = String(req.body.entry_type || "update").toLowerCase();

  if (!goalText) {
    if (req.file) deleteUploadedFile(`/uploads/goal-entries/${req.file.filename}`);
    setFlash(req, "error", "Please enter text for the entry.");
    return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
  }

  const mentorship = db
    .prepare(
      `SELECT m.id, m.status, mentor.email AS mentor_email, s.name AS section_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.id = ? AND m.mentee_id = ? AND m.status IN ('pending', 'accepted')`
    )
    .get(mentorshipId, req.currentUser.id);

  if (!mentorship) {
    if (req.file) deleteUploadedFile(`/uploads/goal-entries/${req.file.filename}`);
    setFlash(req, "error", "Mentorship not found or no longer editable.");
    return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
  }

  const filePath = req.file ? getStoragePath(req.file.filename) : null;
  const fileName = req.file ? req.file.originalname : null;

  db.prepare(
    `INSERT INTO goal_entries (mentorship_id, user_id, type, content, file_path, file_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).run(mentorshipId, req.currentUser.id, entryType, goalText, filePath, fileName);

  sendSystemEmail({
    to: mentorship.mentor_email,
    subject: "A new msg from your Mentee has been submitted.",
    html: `<p>A new next step record was added by your mentee.</p><p><strong>Entry:</strong></p><p>${escapeHtml(goalText).replace(/\n/g, "<br />")}</p><p><a href="${req.protocol}://${req.get("host")}/mentor/mentorship/${mentorshipId}/goals">Open the goals page</a></p>`,
    text: `A new next step record was added by your mentee. Entry: ${goalText}. Open the goals page: ${req.protocol}://${req.get("host")}/mentor/mentorship/${mentorshipId}/goals`,
    eventType: "mentee_goal_entry_added",
    actorUserId: req.currentUser.id,
  }).catch((err) => {
    console.error("Failed to send mentee goal entry email", err);
  });

  setFlash(req, "success", "Entry added.");
  return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
});

router.post("/mentorship/:id/goals/:entryId/edit", uploadWithErrorHandling, (req, res) => {
  const mentorshipId = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  const goalText = String(req.body.goal_entry || "").trim();
  const entryType = String(req.body.entry_type || "update").toLowerCase();
  const removeFile = req.body[`remove_file_${entryId}`] === '1';

  if (!goalText) {
    if (req.file) deleteUploadedFile(`/uploads/goal-entries/${req.file.filename}`);
    setFlash(req, "error", "Please enter text for the entry.");
    return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
  }

  const entry = db
    .prepare(
      `SELECT ge.* FROM goal_entries ge
       JOIN mentorships m ON m.id = ge.mentorship_id
       WHERE ge.id = ? AND ge.user_id = ? AND m.mentee_id = ?`
    )
    .get(entryId, req.currentUser.id, req.currentUser.id);

  if (!entry) {
    if (req.file) deleteUploadedFile(`/uploads/goal-entries/${req.file.filename}`);
    setFlash(req, "error", "Entry not found or you don't have permission to edit it.");
    return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
  }

  let filePath = entry.file_path;
  let fileName = entry.file_name;

  // Handle file removal
  if (removeFile && entry.file_path) {
    deleteUploadedFile(entry.file_path);
    filePath = null;
    fileName = null;
  }

  // Delete old file if exists and a new one is uploaded
  if (req.file && entry.file_path) {
    deleteUploadedFile(entry.file_path);
  }

  // Use new file if uploaded
  if (req.file) {
    filePath = getStoragePath(req.file.filename);
    fileName = req.file.originalname;
  }

  db.prepare(
    `UPDATE goal_entries SET type = ?, content = ?, file_path = ?, file_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(entryType, goalText, filePath, fileName, entryId);

  setFlash(req, "success", "Entry updated.");
  return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
});

router.post("/mentorship/:id/goals/:entryId/delete", (req, res) => {
  const mentorshipId = Number(req.params.id);
  const entryId = Number(req.params.entryId);

  const entry = db
    .prepare(
      `SELECT ge.* FROM goal_entries ge
       JOIN mentorships m ON m.id = ge.mentorship_id
       WHERE ge.id = ? AND ge.user_id = ? AND m.mentee_id = ?`
    )
    .get(entryId, req.currentUser.id, req.currentUser.id);

  if (!entry) {
    setFlash(req, "error", "Entry not found or you don't have permission to delete it.");
    return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
  }

  // Delete file if exists
  if (entry.file_path) {
    deleteUploadedFile(entry.file_path);
  }

  db.prepare("DELETE FROM goal_entries WHERE id = ?").run(entryId);

  setFlash(req, "success", "Entry deleted.");
  return res.redirect(`/mentee/mentorship/${mentorshipId}/goals`);
});

module.exports = router;
