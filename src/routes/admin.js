const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { db } = require("../db");
const { requireRole, setFlash } = require("../middleware/auth");
const { sendSystemEmail, testSmtpDelivery } = require("../utils/mailer");

const router = express.Router();
router.use(requireRole("admin"));

const THEME_FIELDS = [
  "bg_color",
  "paper_color",
  "ink_color",
  "accent_color",
  "accent_2_color",
  "danger_color",
  "warning_color",
  "muted_color",
  "line_color",
  "bg_soft_color",
  "header_start_color",
  "header_end_color",
  "field_border_color",
  "surface_color",
  "btn_text_color",
  "btn_disabled_bg_color",
  "btn_disabled_text_color",
  "flash_success_bg_color",
  "flash_success_text_color",
  "flash_error_bg_color",
  "flash_error_text_color",
  "danger_soft_color",
];

const logoDir = path.join(__dirname, "..", "public", "uploads", "logos");
if (!fs.existsSync(logoDir)) {
  fs.mkdirSync(logoDir, { recursive: true });
}

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, logoDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".svg", ".webp"].includes(ext) ? ext : ".png";
    cb(null, `company-logo-${Date.now()}${safeExt}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image files are allowed for logo upload."));
  },
});

function parseIdArray(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
}

function getLocationUsageCount(id) {
  const mentorCount = db.prepare("SELECT COUNT(*) AS c FROM mentor_profiles WHERE location_id = ?").get(id).c;
  const menteeCount = db.prepare("SELECT COUNT(*) AS c FROM mentee_profiles WHERE location_id = ?").get(id).c;
  return Number(mentorCount) + Number(menteeCount);
}

function getFunctionUsageCount(id) {
  const mentorCount = db.prepare("SELECT COUNT(*) AS c FROM mentor_sections WHERE section_id = ?").get(id).c;
  const mentorshipCount = db.prepare("SELECT COUNT(*) AS c FROM mentorships WHERE section_id = ?").get(id).c;
  return Number(mentorCount) + Number(mentorshipCount);
}

function getEndReasonUsageCount(id) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM mentorships WHERE end_reason_id = ?").get(id).c);
}

function ensureAdminResetReasonId() {
  const existing = db.prepare("SELECT id FROM end_reasons WHERE name = ?").get("Reset by Admin");
  if (existing) return existing.id;
  const inserted = db.prepare("INSERT INTO end_reasons (name) VALUES (?)").run("Reset by Admin");
  return Number(inserted.lastInsertRowid);
}

function csvEscape(value) {
  const raw = value === null || value === undefined ? "" : String(value);
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
}

function sqlDisplayName(alias) {
  const base = `COALESCE(NULLIF(TRIM(COALESCE(${alias}.title || ' ', '') || COALESCE(${alias}.first_name || ' ', '') || COALESCE(${alias}.surname, '')), ''), ${alias}.email)`;
  return `CASE WHEN NULLIF(TRIM(COALESCE(${alias}.pronouns, '')), '') IS NOT NULL THEN ${base} || ' (' || TRIM(${alias}.pronouns) || ')' ELSE ${base} END`;
}

function sqlSurnameSort(alias) {
  return `COALESCE(NULLIF(LOWER(TRIM(${alias}.surname)), ''), LOWER(${alias}.email))`;
}

function parseSort(query, allowedKeys, defaultKey, defaultDir = "desc") {
  const key = String(query.sort || "").trim();
  const dir = String(query.dir || defaultDir).trim().toLowerCase() === "asc" ? "asc" : "desc";
  const resolvedKey = allowedKeys.includes(key) ? key : defaultKey;
  return { key: resolvedKey, dir };
}

function createSortState(sort, path, query = {}) {
  const fixedQuery = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (v === null || v === undefined) continue;
    const str = String(v).trim();
    if (!str) continue;
    fixedQuery[k] = str;
  }

  return {
    key: sort.key,
    dir: sort.dir,
    path,
    query: fixedQuery,
    href(columnKey) {
      const nextDir = this.key === columnKey && this.dir === "asc" ? "desc" : "asc";
      return this.hrefFor(columnKey, nextDir);
    },
    hrefFor(columnKey, dir) {
      const resolvedDir = dir === "asc" ? "asc" : "desc";
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(this.query)) {
        params.set(k, v);
      }
      params.set("sort", columnKey);
      params.set("dir", resolvedDir);
      return `${this.path}?${params.toString()}`;
    },
    mark(columnKey) {
      if (this.key !== columnKey) return "";
      return this.dir === "asc" ? " ↑" : " ↓";
    },
  };
}

function isHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "").trim());
}

function getThemeSettings() {
  return db.prepare("SELECT * FROM site_settings WHERE id = 1").get();
}

router.get("/", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const sections = db.prepare("SELECT * FROM sections ORDER BY name").all();
  const endReasons = db.prepare("SELECT * FROM end_reasons ORDER BY name").all();
  const counts = {
    mentors: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role IN ('mentor', 'both')").get().c,
    mentees: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role IN ('mentee', 'both')").get().c,
    pending: db.prepare("SELECT COUNT(*) AS c FROM mentorships WHERE status='pending'").get().c,
    accepted: db.prepare("SELECT COUNT(*) AS c FROM mentorships WHERE status='accepted'").get().c,
  };

  return res.render("admin/index", {
    title: "Admin Dashboard",
    locations,
    sections,
    endReasons,
    counts,
  });
});

router.get("/smtp", (req, res) => {
  const smtp = db.prepare("SELECT * FROM smtp_settings WHERE id=1").get();

  return res.render("admin/smtp", {
    title: "SMTP Settings",
    smtp,
  });
});

router.get("/theme", (req, res) => {
  const theme = getThemeSettings();
  return res.render("admin/theme", {
    title: "Theme Settings",
    theme,
  });
});

router.post("/theme", (req, res) => {
  const payload = {};

  for (const field of THEME_FIELDS) {
    const value = String(req.body[field] || "").trim();
    if (!isHexColor(value)) {
      setFlash(req, "error", `Invalid hex color for ${field}. Use format #RRGGBB.`);
      return res.redirect("/admin/theme");
    }
    payload[field] = value.toLowerCase();
  }

  const assignments = THEME_FIELDS.map((field) => `${field} = @${field}`).join(", ");
  db.prepare(`UPDATE site_settings SET ${assignments} WHERE id = 1`).run(payload);

  setFlash(req, "success", "Theme colors updated.");
  return res.redirect("/admin/theme");
});

router.post("/theme/logo", (req, res) => {
  uploadLogo.single("company_logo")(req, res, (err) => {
    if (err) {
      setFlash(req, "error", String(err.message || err));
      return res.redirect("/admin/theme");
    }

    if (!req.file) {
      setFlash(req, "error", "Please choose an image file to upload.");
      return res.redirect("/admin/theme");
    }

    const previous = getThemeSettings();
    const logoPath = `/uploads/logos/${req.file.filename}`;
    db.prepare("UPDATE site_settings SET logo_path = ? WHERE id = 1").run(logoPath);

    if (previous?.logo_path && previous.logo_path.startsWith("/uploads/logos/")) {
      const previousFile = path.join(__dirname, "..", "public", previous.logo_path.replace(/^\//, ""));
      if (previousFile !== req.file.path && fs.existsSync(previousFile)) {
        fs.unlink(previousFile, () => {});
      }
    }

    setFlash(req, "success", "Company logo updated.");
    return res.redirect("/admin/theme");
  });
});

router.get("/history", (req, res) => {
  const sort = parseSort(
    req.query,
    [
      "id",
      "status",
      "mentor_name",
      "mentor_email",
      "mentee_name",
      "mentee_email",
      "location_name",
      "section_name",
      "end_reason_name",
      "ended_by_name",
      "ended_by_email",
      "mentor_message",
      "created_at",
      "updated_at",
    ],
    "updated_at",
    "desc"
  );
  const orderByMap = {
    id: "m.id",
    status: "m.status",
    mentor_name: sqlSurnameSort("mentor"),
    mentor_email: "mentor.email",
    mentee_name: sqlSurnameSort("mentee"),
    mentee_email: "mentee.email",
    location_name: "loc.name",
    section_name: "s.name",
    end_reason_name: "er.name",
    ended_by_name: sqlSurnameSort("ended_by"),
    ended_by_email: "ended_by.email",
    mentor_message: "m.mentor_message",
    created_at: "m.created_at",
    updated_at: "m.updated_at",
  };
  const orderBy = `${orderByMap[sort.key]} ${sort.dir.toUpperCase()}`;

  const rows = db
    .prepare(
      `SELECT
         m.id,
         m.status,
         m.mentor_message,
         m.created_at,
         m.updated_at,
         ${sqlDisplayName("mentor")} AS mentor_name,
         mentor.email AS mentor_email,
         ${sqlDisplayName("mentee")} AS mentee_name,
         mentee.email AS mentee_email,
         loc.name AS location_name,
         s.name AS section_name,
         er.name AS end_reason_name,
         ${sqlDisplayName("ended_by")} AS ended_by_name,
         ended_by.email AS ended_by_email
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN mentee_profiles mp ON mp.user_id = m.mentee_id
       LEFT JOIN locations loc ON loc.id = mp.location_id
       LEFT JOIN sections s ON s.id = m.section_id
       LEFT JOIN end_reasons er ON er.id = m.end_reason_id
       LEFT JOIN users ended_by ON ended_by.id = m.ended_by_user_id
       ORDER BY ${orderBy}`
    )
    .all();

  return res.render("admin/history", {
    title: "Relationship History",
    rows,
    sort: createSortState(sort, "/admin/history", {}),
  });
});

router.get("/audit", (req, res) => {
  const eventType = String(req.query.eventType || "").trim();
  const status = String(req.query.status || "").trim();
  const recipient = String(req.query.recipient || "").trim();
  const fromDate = String(req.query.fromDate || "").trim();
  const toDate = String(req.query.toDate || "").trim();
  const sort = parseSort(req.query, ["created_at", "status", "event_type", "recipient_email", "subject"], "created_at", "desc");
  const orderByMap = {
    created_at: "created_at",
    status: "status",
    event_type: "event_type",
    recipient_email: "recipient_email",
    subject: "subject",
  };
  const orderBy = `${orderByMap[sort.key]} ${sort.dir.toUpperCase()}`;

  const where = [];
  const params = [];

  if (eventType) {
    where.push("event_type = ?");
    params.push(eventType);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (recipient) {
    where.push("recipient_email LIKE ?");
    params.push(`%${recipient}%`);
  }
  if (fromDate) {
    where.push("datetime(created_at) >= datetime(?)");
    params.push(fromDate);
  }
  if (toDate) {
    where.push("datetime(created_at) <= datetime(?)");
    params.push(`${toDate} 23:59:59`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const logs = db
    .prepare(
      `SELECT id, event_type, status, recipient_email, subject, error_message, created_at
       FROM email_audit_logs
       ${whereSql}
       ORDER BY ${orderBy}, id DESC
       LIMIT 500`
    )
    .all(...params);

  return res.render("admin/audit", {
    title: "Audit Log",
    logs,
    filters: {
      eventType,
      status,
      recipient,
      fromDate,
      toDate,
    },
    sort: createSortState(sort, "/admin/audit", {
      eventType,
      status,
      recipient,
      fromDate,
      toDate,
    }),
  });
});

router.get("/users", (req, res) => {
  const roleFilter = String(req.query.role || "").trim().toLowerCase();
  const sort = parseSort(
    req.query,
    ["id", "user_name", "email", "role", "location_name", "active_mentor_count", "active_mentee_count", "created_at", "updated_at"],
    "created_at",
    "desc"
  );
  const orderByMap = {
    id: "u.id",
    user_name: sqlSurnameSort("u"),
    email: "u.email",
    role: "u.role",
    location_name: "location_name",
    active_mentor_count: "active_mentor_count",
    active_mentee_count: "active_mentee_count",
    created_at: "u.created_at",
    updated_at: "u.updated_at",
  };
  const orderBy = `${orderByMap[sort.key]} ${sort.dir.toUpperCase()}`;

  let roleSql = "";
  if (roleFilter === "mentor") {
    roleSql = "WHERE u.role IN ('mentor', 'both')";
  } else if (roleFilter === "mentee") {
    roleSql = "WHERE u.role IN ('mentee', 'both')";
  }

  const users = db
    .prepare(
      `SELECT
         u.id,
         u.role,
         u.email,
        ${sqlDisplayName("u")} AS user_name,
         u.created_at,
         u.updated_at,
         CASE
           WHEN u.role = 'mentor' THEN mentor_loc.name
           WHEN u.role = 'mentee' THEN mentee_loc.name
           WHEN u.role = 'both' THEN COALESCE(mentor_loc.name, mentee_loc.name)
           ELSE NULL
         END AS location_name,
         COALESCE(mc.active_count, 0) AS active_mentor_count,
         COALESCE(tc.active_count, 0) AS active_mentee_count
       FROM users u
       LEFT JOIN mentor_profiles mp ON mp.user_id = u.id
       LEFT JOIN locations mentor_loc ON mentor_loc.id = mp.location_id
       LEFT JOIN mentee_profiles tp ON tp.user_id = u.id
       LEFT JOIN locations mentee_loc ON mentee_loc.id = tp.location_id
       LEFT JOIN (
         SELECT mentor_id, COUNT(*) AS active_count
         FROM mentorships
         WHERE status != 'ended'
         GROUP BY mentor_id
       ) mc ON mc.mentor_id = u.id
       LEFT JOIN (
         SELECT mentee_id, COUNT(*) AS active_count
         FROM mentorships
         WHERE status != 'ended'
         GROUP BY mentee_id
       ) tc ON tc.mentee_id = u.id
       ${roleSql}
       ORDER BY ${orderBy}`
    )
    .all();

  return res.render("admin/users", {
    title: "Users",
    users,
    roleFilter,
    sort: createSortState(sort, "/admin/users", {
      role: roleFilter,
    }),
  });
});

router.get("/requests", (req, res) => {
  const sort = parseSort(
    req.query,
    ["id", "mentee_name", "mentor_name", "mentee_email", "mentor_email", "location_name", "section_name", "created_at", "updated_at"],
    "created_at",
    "desc"
  );
  const orderByMap = {
    id: "m.id",
    mentee_name: sqlSurnameSort("mentee"),
    mentee_email: "mentee.email",
    mentor_name: sqlSurnameSort("mentor"),
    mentor_email: "mentor.email",
    location_name: "loc.name",
    section_name: "s.name",
    created_at: "m.created_at",
    updated_at: "m.updated_at",
  };
  const orderBy = `${orderByMap[sort.key]} ${sort.dir.toUpperCase()}`;

  const requests = db
    .prepare(
      `SELECT
         m.id,
         m.created_at,
         m.updated_at,
         m.section_id,
         ${sqlDisplayName("mentor")} AS mentor_name,
         mentor.email AS mentor_email,
         ${sqlDisplayName("mentee")} AS mentee_name,
         mentee.email AS mentee_email,
         loc.name AS location_name,
         s.name AS section_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN mentee_profiles mp ON mp.user_id = m.mentee_id
       LEFT JOIN locations loc ON loc.id = mp.location_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.status = 'pending'
       ORDER BY ${orderBy}`
    )
    .all();

  return res.render("admin/requests", {
    title: "Pending Requests",
    requests,
    sort: createSortState(sort, "/admin/requests", {}),
  });
});

router.post("/requests/:id/resend", async (req, res) => {
  const requestId = Number(req.params.id);
  if (!requestId) {
    setFlash(req, "error", "Invalid request.");
    return res.redirect("/admin/requests");
  }

  const request = db
    .prepare(
      `SELECT
         m.id,
         m.status,
         m.section_id,
         mentor.email AS mentor_email,
         mentee.email AS mentee_email,
         s.name AS section_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.id = ?`
    )
    .get(requestId);

  if (!request || request.status !== "pending") {
    setFlash(req, "error", "Request not found or no longer pending.");
    return res.redirect("/admin/requests");
  }

  const base = process.env.BASE_URL || "http://localhost:3000";
  const actionLink = `${base}/mentor`;

  try {
    await sendSystemEmail({
      to: request.mentor_email,
      subject: "Reminder: mentorship request in Manatee",
      html: `<p>You have a pending mentorship request from ${request.mentee_email}.</p><p>Function: ${request.section_name || "N/A"}</p><p><a href=\"${actionLink}\">Review request</a></p><p>Request ID: ${request.id}</p>`,
      text: `You have a pending mentorship request from ${request.mentee_email}. Function: ${request.section_name || "N/A"}. Review: ${actionLink} (Request ID: ${request.id})`,
      eventType: "admin_resend_pending_request",
      actorUserId: req.currentUser.id,
    });
    setFlash(req, "success", `Request reminder resent to ${request.mentor_email}.`);
  } catch (err) {
    setFlash(req, "error", `Failed to resend request: ${String(err?.message || err)}`);
  }

  return res.redirect("/admin/requests");
});

router.get("/relationships", (req, res) => {
  const sort = parseSort(
    req.query,
    ["id", "mentee_name", "mentor_name", "mentee_email", "mentor_email", "location_name", "section_name", "created_at", "updated_at"],
    "updated_at",
    "desc"
  );
  const orderByMap = {
    id: "m.id",
    mentee_name: sqlSurnameSort("mentee"),
    mentee_email: "mentee.email",
    mentor_name: sqlSurnameSort("mentor"),
    mentor_email: "mentor.email",
    location_name: "loc.name",
    section_name: "s.name",
    created_at: "m.created_at",
    updated_at: "m.updated_at",
  };
  const orderBy = `${orderByMap[sort.key]} ${sort.dir.toUpperCase()}`;

  const rows = db
    .prepare(
      `SELECT
         m.id,
         m.created_at,
         m.updated_at,
        ${sqlDisplayName("mentor")} AS mentor_name,
         mentor.email AS mentor_email,
        ${sqlDisplayName("mentee")} AS mentee_name,
         mentee.email AS mentee_email,
         loc.name AS location_name,
         s.name AS section_name
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN mentee_profiles mp ON mp.user_id = m.mentee_id
       LEFT JOIN locations loc ON loc.id = mp.location_id
       LEFT JOIN sections s ON s.id = m.section_id
       WHERE m.status = 'accepted'
       ORDER BY ${orderBy}`
    )
    .all();

  return res.render("admin/relationships", {
    title: "Live Relationships",
    rows,
    sort: createSortState(sort, "/admin/relationships", {}),
  });
});

router.post("/relationships/:id/remove", (req, res) => {
  const relationshipId = Number(req.params.id);
  if (!relationshipId) {
    setFlash(req, "error", "Invalid relationship.");
    return res.redirect("/admin/relationships");
  }

  const row = db
    .prepare("SELECT id, mentor_id, mentee_id, status FROM mentorships WHERE id = ?")
    .get(relationshipId);
  if (!row || row.status !== "accepted") {
    setFlash(req, "error", "Relationship not found or already closed.");
    return res.redirect("/admin/relationships");
  }

  const adminResetReasonId = ensureAdminResetReasonId();
  db.prepare(
    `UPDATE mentorships
     SET status = 'ended',
         end_reason_id = ?,
         ended_by_user_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'accepted'`
  ).run(adminResetReasonId, req.currentUser.id, relationshipId);

  setFlash(req, "success", `Relationship ${relationshipId} removed.`);
  return res.redirect("/admin/relationships");
});

router.post("/users/:id/delete", (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    setFlash(req, "error", "Invalid user.");
    return res.redirect("/admin/users");
  }

  if (userId === req.currentUser.id) {
    setFlash(req, "error", "You cannot delete your own admin account.");
    return res.redirect("/admin/users");
  }

  const user = db.prepare("SELECT id, email, role FROM users WHERE id = ?").get(userId);
  if (!user) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }

  if (user.role === "admin") {
    setFlash(req, "error", "Admin users cannot be deleted here.");
    return res.redirect("/admin/users");
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  setFlash(req, "success", `User deleted: ${user.email}`);
  return res.redirect("/admin/users");
});

router.get("/history/export", (req, res) => {
  const rows = db
    .prepare(
      `SELECT
         m.id,
         m.status,
         m.mentor_message,
         m.created_at,
         m.updated_at,
         mentor.email AS mentor_email,
         mentee.email AS mentee_email,
         s.name AS section_name,
         er.name AS end_reason_name,
         ended_by.email AS ended_by_email
       FROM mentorships m
       JOIN users mentor ON mentor.id = m.mentor_id
       JOIN users mentee ON mentee.id = m.mentee_id
       LEFT JOIN sections s ON s.id = m.section_id
       LEFT JOIN end_reasons er ON er.id = m.end_reason_id
       LEFT JOIN users ended_by ON ended_by.id = m.ended_by_user_id
       ORDER BY m.updated_at DESC`
    )
    .all();

  const headers = [
    "relationship_id",
    "status",
    "mentor_email",
    "mentee_email",
    "function",
    "end_reason",
    "ended_by",
    "mentor_message",
    "created_at",
    "updated_at",
  ];

  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.status,
        row.mentor_email,
        row.mentee_email,
        row.section_name || "",
        row.end_reason_name || "",
        row.ended_by_email || "",
        row.mentor_message || "",
        row.created_at,
        row.updated_at,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const content = `${lines.join("\n")}\n`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=manatee-relationship-history-${stamp}.csv`);
  return res.status(200).send(content);
});

router.post("/locations", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    setFlash(req, "error", "Location name is required.");
    return res.redirect("/admin");
  }

  db.prepare("INSERT OR IGNORE INTO locations (name) VALUES (?)").run(name);
  setFlash(req, "success", "Location saved.");
  return res.redirect("/admin");
});

router.post("/locations/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    setFlash(req, "error", "Invalid location.");
    return res.redirect("/admin");
  }

  if (getLocationUsageCount(id) > 0) {
    setFlash(req, "error", "Location is in use and cannot be deleted.");
    return res.redirect("/admin");
  }

  db.prepare("DELETE FROM locations WHERE id = ?").run(id);
  setFlash(req, "success", "Location removed.");
  return res.redirect("/admin");
});

router.post("/locations/:id/update", (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || "").trim();

  if (!id || !name) {
    setFlash(req, "error", "Location update requires a valid name.");
    return res.redirect("/admin");
  }

  if (getLocationUsageCount(id) > 0) {
    setFlash(req, "error", "Location is in use and cannot be edited.");
    return res.redirect("/admin");
  }

  const duplicate = db
    .prepare("SELECT id FROM locations WHERE lower(name) = lower(?) AND id != ?")
    .get(name, id);
  if (duplicate) {
    setFlash(req, "error", "Location name already exists.");
    return res.redirect("/admin");
  }

  db.prepare("UPDATE locations SET name = ? WHERE id = ?").run(name, id);
  setFlash(req, "success", "Location updated.");
  return res.redirect("/admin");
});

router.post("/locations/bulk-delete", (req, res) => {
  const ids = parseIdArray(req.body.ids);
  if (!ids.length) {
    setFlash(req, "error", "Select at least one location to delete.");
    return res.redirect("/admin");
  }

  const removableIds = ids.filter((id) => getLocationUsageCount(id) === 0);
  const blockedIds = ids.filter((id) => getLocationUsageCount(id) > 0);

  let changes = 0;
  if (removableIds.length) {
    const stmt = db.prepare("DELETE FROM locations WHERE id = ?");
    const tx = db.transaction((inputIds) => {
      let count = 0;
      for (const id of inputIds) {
        count += stmt.run(id).changes;
      }
      return count;
    });
    changes = tx(removableIds);
  }

  if (blockedIds.length) {
    setFlash(req, "error", `${changes} location(s) removed. ${blockedIds.length} location(s) are in use and were skipped.`);
    return res.redirect("/admin");
  }

  setFlash(req, "success", `${changes} location(s) removed.`);
  return res.redirect("/admin");
});

router.post("/sections", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    setFlash(req, "error", "Function name is required.");
    return res.redirect("/admin");
  }

  db.prepare("INSERT OR IGNORE INTO sections (name) VALUES (?)").run(name);
  setFlash(req, "success", "Function saved.");
  return res.redirect("/admin");
});

router.post("/sections/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    setFlash(req, "error", "Invalid function.");
    return res.redirect("/admin");
  }

  if (getFunctionUsageCount(id) > 0) {
    setFlash(req, "error", "Function is in use and cannot be deleted.");
    return res.redirect("/admin");
  }

  db.prepare("DELETE FROM sections WHERE id = ?").run(id);
  setFlash(req, "success", "Function removed.");
  return res.redirect("/admin");
});

router.post("/sections/:id/update", (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || "").trim();

  if (!id || !name) {
    setFlash(req, "error", "Function update requires a valid name.");
    return res.redirect("/admin");
  }

  if (getFunctionUsageCount(id) > 0) {
    setFlash(req, "error", "Function is in use and cannot be edited.");
    return res.redirect("/admin");
  }

  const duplicate = db
    .prepare("SELECT id FROM sections WHERE lower(name) = lower(?) AND id != ?")
    .get(name, id);
  if (duplicate) {
    setFlash(req, "error", "Function name already exists.");
    return res.redirect("/admin");
  }

  db.prepare("UPDATE sections SET name = ? WHERE id = ?").run(name, id);
  setFlash(req, "success", "Function updated.");
  return res.redirect("/admin");
});

router.post("/sections/bulk-delete", (req, res) => {
  const ids = parseIdArray(req.body.ids);
  if (!ids.length) {
    setFlash(req, "error", "Select at least one function to delete.");
    return res.redirect("/admin");
  }

  const removableIds = ids.filter((id) => getFunctionUsageCount(id) === 0);
  const blockedIds = ids.filter((id) => getFunctionUsageCount(id) > 0);

  let changes = 0;
  if (removableIds.length) {
    const stmt = db.prepare("DELETE FROM sections WHERE id = ?");
    const tx = db.transaction((inputIds) => {
      let count = 0;
      for (const id of inputIds) {
        count += stmt.run(id).changes;
      }
      return count;
    });
    changes = tx(removableIds);
  }

  if (blockedIds.length) {
    setFlash(req, "error", `${changes} function(s) removed. ${blockedIds.length} function(s) are in use and were skipped.`);
    return res.redirect("/admin");
  }

  setFlash(req, "success", `${changes} function(s) removed.`);
  return res.redirect("/admin");
});

router.post("/end-reasons", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    setFlash(req, "error", "Reason name is required.");
    return res.redirect("/admin");
  }

  db.prepare("INSERT OR IGNORE INTO end_reasons (name) VALUES (?)").run(name);
  setFlash(req, "success", "End reason saved.");
  return res.redirect("/admin");
});

router.post("/end-reasons/:id/delete", (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    setFlash(req, "error", "Invalid end reason.");
    return res.redirect("/admin");
  }

  if (getEndReasonUsageCount(id) > 0) {
    setFlash(req, "error", "End reason is in use and cannot be deleted.");
    return res.redirect("/admin");
  }

  db.prepare("DELETE FROM end_reasons WHERE id = ?").run(id);
  setFlash(req, "success", "End reason removed.");
  return res.redirect("/admin");
});

router.post("/end-reasons/:id/update", (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || "").trim();

  if (!id || !name) {
    setFlash(req, "error", "End reason update requires a valid name.");
    return res.redirect("/admin");
  }

  if (getEndReasonUsageCount(id) > 0) {
    setFlash(req, "error", "End reason is in use and cannot be edited.");
    return res.redirect("/admin");
  }

  const duplicate = db
    .prepare("SELECT id FROM end_reasons WHERE lower(name) = lower(?) AND id != ?")
    .get(name, id);
  if (duplicate) {
    setFlash(req, "error", "End reason name already exists.");
    return res.redirect("/admin");
  }

  db.prepare("UPDATE end_reasons SET name = ? WHERE id = ?").run(name, id);
  setFlash(req, "success", "End reason updated.");
  return res.redirect("/admin");
});

router.post("/end-reasons/bulk-delete", (req, res) => {
  const ids = parseIdArray(req.body.ids);
  if (!ids.length) {
    setFlash(req, "error", "Select at least one end reason to delete.");
    return res.redirect("/admin");
  }

  const removableIds = ids.filter((id) => getEndReasonUsageCount(id) === 0);
  const blockedIds = ids.filter((id) => getEndReasonUsageCount(id) > 0);

  let changes = 0;
  if (removableIds.length) {
    const stmt = db.prepare("DELETE FROM end_reasons WHERE id = ?");
    const tx = db.transaction((inputIds) => {
      let count = 0;
      for (const id of inputIds) {
        count += stmt.run(id).changes;
      }
      return count;
    });
    changes = tx(removableIds);
  }

  if (blockedIds.length) {
    setFlash(req, "error", `${changes} end reason(s) removed. ${blockedIds.length} end reason(s) are in use and were skipped.`);
    return res.redirect("/admin");
  }

  setFlash(req, "success", `${changes} end reason(s) removed.`);
  return res.redirect("/admin");
});

router.post("/smtp", (req, res) => {
  const smtpUser = String(req.body.smtp_user || req.body.user || "").trim() || null;
  const smtpPassword = String(req.body.smtp_password || req.body.pass || "").trim() || null;
  const fromEmail = String(req.body.from_email || "").trim() || null;

  if (!fromEmail) {
    setFlash(req, "error", "From Email is required.");
    return res.redirect("/admin/smtp");
  }

  const payload = {
    host: String(req.body.host || "").trim() || null,
    port: req.body.port ? Number(req.body.port) : null,
    secure: req.body.secure === "on" ? 1 : 0,
    user: smtpUser,
    pass: smtpPassword,
    from_email: fromEmail,
    bcc_email: String(req.body.bcc_email || "").trim() || null,
  };

  db.prepare(
    `UPDATE smtp_settings
     SET host=@host, port=@port, secure=@secure, user=@user, pass=@pass,
         from_email=@from_email, bcc_email=@bcc_email
     WHERE id=1`
  ).run(payload);

  setFlash(req, "success", "SMTP settings updated.");
  return res.redirect("/admin/smtp");
});

router.post("/smtp/test", async (req, res) => {
  const testTo = String(req.body.test_to || "").trim() || req.currentUser.email;

  try {
    const testResult = await testSmtpDelivery({ to: testTo });

    if (!testResult.ok) {
      db.prepare(
        `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
         VALUES ('smtp_test', 'failed', ?, 'Manatee SMTP Test', ?, ?)`
      ).run(testTo, testResult.message, req.currentUser.id);

      setFlash(req, "error", `SMTP test failed: ${testResult.message}`);
      return res.redirect("/admin/smtp");
    }

    db.prepare(
      `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
       VALUES ('smtp_test', 'sent', ?, 'Manatee SMTP Test', ?, ?)`
    ).run(
      testTo,
      `messageId=${testResult.details?.messageId || ""}; response=${testResult.details?.response || ""}`,
      req.currentUser.id
    );

    setFlash(
      req,
      "success",
      `SMTP test accepted by server for ${testTo}. Message ID: ${testResult.details?.messageId || "n/a"}`
    );
    return res.redirect("/admin/smtp");
  } catch (err) {
    db.prepare(
      `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
       VALUES ('smtp_test', 'failed', ?, 'Manatee SMTP Test', ?, ?)`
    ).run(testTo, String(err?.message || err), req.currentUser.id);

    setFlash(req, "error", `SMTP test failed: ${String(err?.message || err)}`);
    return res.redirect("/admin/smtp");
  }
});

router.post("/reset-matches", (req, res) => {
  const mentorId = Number(req.body.mentor_id || 0);
  if (!mentorId) {
    setFlash(req, "error", "Please select a mentor.");
    return res.redirect("/admin");
  }

  const mentor = db
    .prepare("SELECT id, email FROM users WHERE id = ? AND role IN ('mentor', 'both')")
    .get(mentorId);
  if (!mentor) {
    setFlash(req, "error", "Selected mentor was not found.");
    return res.redirect("/admin");
  }

  const adminResetReasonId = ensureAdminResetReasonId();
  const result = db
    .prepare(
      `UPDATE mentorships
       SET status = 'ended',
           end_reason_id = ?,
           ended_by_user_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE mentor_id = ?
         AND status != 'ended'`
    )
    .run(adminResetReasonId, req.currentUser.id, mentorId);

  setFlash(req, "success", `${result.changes} active mentorship record(s) archived for ${mentor.email}.`);
  return res.redirect("/admin");
});

module.exports = router;
