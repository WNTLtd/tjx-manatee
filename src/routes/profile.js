const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { requireAuth, setFlash } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res) => {
  const user = db
    .prepare("SELECT id, role, email, title, pronouns, first_name, surname, job_title FROM users WHERE id = ?")
    .get(req.currentUser.id);
  return res.render("profile/index", {
    title: "Account Settings",
    user,
  });
});

router.post("/details", (req, res) => {
  const title = String(req.body.title || "").trim() || null;
  const pronouns = String(req.body.pronouns || "").trim() || null;
  const firstName = String(req.body.first_name || "").trim() || null;
  const surname = String(req.body.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || "").trim() || null;

  db.prepare(
    "UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(title, pronouns, firstName, surname, jobTitle, req.currentUser.id);

  setFlash(req, "success", "Personal details updated.");
  return res.redirect("/profile");
});

router.post("/email", (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!email) {
    setFlash(req, "error", "Email is required.");
    return res.redirect("/profile");
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.currentUser.id);
  if (existing) {
    setFlash(req, "error", "Email already in use.");
    return res.redirect("/profile");
  }

  db.prepare("UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(email, req.currentUser.id);
  setFlash(req, "success", "Email updated.");
  return res.redirect("/profile");
});

router.post("/password", (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.currentUser.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    setFlash(req, "error", "Current password is incorrect.");
    return res.redirect("/profile");
  }

  if (newPassword.length < 6) {
    setFlash(req, "error", "New password must be at least 6 characters.");
    return res.redirect("/profile");
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(hash, req.currentUser.id);

  setFlash(req, "success", "Password updated.");
  return res.redirect("/profile");
});

module.exports = router;
