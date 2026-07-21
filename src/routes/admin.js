const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { requireRole, setFlash } = require("../middleware/auth");
const { generateResetToken } = require("../utils/password");
const { sendSystemEmail, testSmtpDelivery, getAppBaseUrl } = require("../utils/mailer");

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
  "goal_badge_color",
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

const faviconDir = path.join(__dirname, "..", "public", "uploads", "logos");
if (!fs.existsSync(faviconDir)) {
  fs.mkdirSync(faviconDir, { recursive: true });
}

const faviconStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, faviconDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".png", ".ico", ".svg"].includes(ext) ? ext : ".png";
    cb(null, `favicon-${Date.now()}${safeExt}`);
  },
});

const uploadFavicon = multer({
  storage: faviconStorage,
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ["image/png", "image/x-icon", "image/svg+xml"];
    const allowedExts = [".png", ".ico", ".svg"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) return cb(null, true);
    return cb(new Error("Only PNG, ICO, or SVG files are allowed for favicon upload."));
  },
});

const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isCsvMime = file.mimetype === "text/csv" || file.mimetype === "application/vnd.ms-excel";
    const isCsvName = String(file.originalname || "").toLowerCase().endsWith(".csv");
    if (isCsvMime || isCsvName) return cb(null, true);
    return cb(new Error("Only CSV files are allowed."));
  },
});

function parseIdArray(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
}

function parseFirstCsvColumn(line) {
  const raw = String(line || "");
  if (!raw.trim()) return "";

  if (raw.trimStart().startsWith('"')) {
    let inQuotes = false;
    let value = "";

    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '"') {
        if (inQuotes && raw[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && ch === ",") break;
      value += ch;
    }

    return value.trim();
  }

  const commaIndex = raw.indexOf(",");
  if (commaIndex === -1) return raw.trim();
  return raw.slice(0, commaIndex).trim();
}

function parseCsvNames(buffer) {
  const text = String(buffer || "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);

  const names = [];
  for (let i = 0; i < lines.length; i += 1) {
    const value = parseFirstCsvColumn(lines[i]);
    if (!value) continue;

    // Optional header support.
    if (i === 0 && value.toLowerCase() === "name") continue;
    names.push(value);
  }
  return names;
}

function importNamedListCsv(req, res, options) {
  const { tableName, label } = options;

  if (!req.file || !req.file.buffer) {
    setFlash(req, "error", `Please choose a CSV file for ${label}.`);
    return res.redirect("/admin");
  }

  const parsed = parseCsvNames(req.file.buffer);
  if (!parsed.length) {
    setFlash(req, "error", `No valid ${label} values were found in the CSV.`);
    return res.redirect("/admin");
  }

  const existingRows = db.prepare(`SELECT name FROM ${tableName}`).all();
  const existing = new Set(existingRows.map((r) => String(r.name || "").trim().toLowerCase()));
  const seenInFile = new Set();

  const uniqueToInsert = [];
  let duplicateInFile = 0;
  let duplicateExisting = 0;

  for (const name of parsed) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) continue;

    if (seenInFile.has(key)) {
      duplicateInFile += 1;
      continue;
    }
    seenInFile.add(key);

    if (existing.has(key)) {
      duplicateExisting += 1;
      continue;
    }

    uniqueToInsert.push(String(name).trim());
    existing.add(key);
  }

  if (!uniqueToInsert.length) {
    setFlash(
      req,
      "error",
      `No ${label} imported. ${duplicateExisting} already existed and ${duplicateInFile} duplicate row(s) were in the file.`
    );
    return res.redirect("/admin");
  }

  const insert = db.prepare(`INSERT INTO ${tableName} (name) VALUES (?)`);
  const tx = db.transaction((items) => {
    let inserted = 0;
    for (const item of items) {
      inserted += insert.run(item).changes;
    }
    return inserted;
  });

  const inserted = tx(uniqueToInsert);
  setFlash(
    req,
    "success",
    `${inserted} ${label} imported. Skipped ${duplicateExisting} existing and ${duplicateInFile} duplicate row(s).`
  );
  return res.redirect("/admin");
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

router.get("/settings", (req, res) => {
  const smtp = db.prepare("SELECT * FROM smtp_settings WHERE id=1").get();

  return res.render("admin/smtp", {
    title: "Settings",
    smtp,
  });
});

router.get("/smtp", (_req, res) => res.redirect("/admin/settings"));

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

router.post("/theme/favicon", (req, res) => {
  uploadFavicon.single("favicon")(req, res, (err) => {
    if (err) {
      setFlash(req, "error", String(err.message || err));
      return res.redirect("/admin/theme");
    }

    if (!req.file) {
      setFlash(req, "error", "Please choose a favicon file to upload.");
      return res.redirect("/admin/theme");
    }

    const previous = getThemeSettings();
    const faviconPath = `/uploads/logos/${req.file.filename}`;
    db.prepare("UPDATE site_settings SET favicon_path = ? WHERE id = 1").run(faviconPath);

    if (previous?.favicon_path && previous.favicon_path.startsWith("/uploads/logos/")) {
      const previousFile = path.join(__dirname, "..", "public", previous.favicon_path.replace(/^\//, ""));
      if (previousFile !== req.file.path && fs.existsSync(previousFile)) {
        fs.unlink(previousFile, () => {});
      }
    }

    setFlash(req, "success", "Favicon updated.");
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
         u.is_superadmin,
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
    canManageAdmins: Boolean(req.currentUser.is_superadmin),
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

  const base = getAppBaseUrl();
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

router.post("/users/admin", async (req, res) => {
  if (!req.currentUser.is_superadmin) {
    setFlash(req, "error", "Only the superuser can create admin accounts.");
    return res.redirect("/admin/users");
  }

  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");

  if (!email || !password) {
    setFlash(req, "error", "Admin email and password are required.");
    return res.redirect("/admin/users");
  }

  if (password.length < 8) {
    setFlash(req, "error", "Admin password must be at least 8 characters.");
    return res.redirect("/admin/users");
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    setFlash(req, "error", "A user with that email already exists.");
    return res.redirect("/admin/users");
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (role, is_superadmin, email, password_hash) VALUES ('admin', 0, ?, ?)").run(email, hash);

  const base = getAppBaseUrl();
  const loginLink = `${base}/login`;
  try {
    await sendSystemEmail({
      to: email,
      subject: "Welcome to Manatee (Admin Access)",
      html: `<p>Your admin account has been created.</p><p><strong>Email:</strong> ${email}</p><p><strong>Temporary password:</strong> ${password}</p><p>Please sign in and change your password immediately.</p><p><a href=\"${loginLink}\">Open Manatee Login</a></p>`,
      text: `Your admin account has been created.\nEmail: ${email}\nTemporary password: ${password}\nPlease sign in and change your password immediately.\nLogin: ${loginLink}`,
      eventType: "admin_user_created",
      actorUserId: req.currentUser.id,
    });
  } catch (err) {
    setFlash(req, "error", `Admin created, but welcome email failed: ${String(err?.message || err)}`);
    return res.redirect("/admin/users");
  }

  setFlash(req, "success", `Admin user created: ${email}`);
  return res.redirect("/admin/users");
});

router.post("/users/:id/resend-welcome", async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    setFlash(req, "error", "Invalid user.");
    return res.redirect("/admin/users");
  }

  const user = db.prepare("SELECT id, email, role, is_superadmin FROM users WHERE id = ?").get(userId);
  if (!user) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }

  if (user.role === "admin" && !req.currentUser.is_superadmin) {
    setFlash(req, "error", "Only the superuser can resend welcome emails to admin accounts.");
    return res.redirect("/admin/users");
  }

  const base = getAppBaseUrl();
  const loginLink = `${base}/login`;
  const displayRole = Number(user.is_superadmin) === 1 ? "superuser admin" : user.role;

  try {
    await sendSystemEmail({
      to: user.email,
      subject: "Welcome to Manatee",
      html: `<p>Hello,</p><p>Your Manatee account is active.</p><p><strong>Role:</strong> ${displayRole}</p><p><a href=\"${loginLink}\">Open Manatee Login</a></p><p>If you do not know your password, use the forgot password link on the login page.</p>`,
      text: `Your Manatee account is active.\nRole: ${displayRole}\nLogin: ${loginLink}\nIf you do not know your password, use the forgot password link on the login page.`,
      eventType: "admin_resend_welcome_email",
      actorUserId: req.currentUser.id,
    });
    setFlash(req, "success", `Welcome email resent to ${user.email}.`);
  } catch (err) {
    setFlash(req, "error", `Failed to resend welcome email: ${String(err?.message || err)}`);
  }

  return res.redirect("/admin/users");
});

router.post("/users/:id/reset-password", async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    setFlash(req, "error", "Invalid user.");
    return res.redirect("/admin/users");
  }

  const user = db.prepare("SELECT id, email, role, is_superadmin FROM users WHERE id = ?").get(userId);
  if (!user) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }

  if (user.role === "admin" && !req.currentUser.is_superadmin) {
    setFlash(req, "error", "Only the superuser can reset admin passwords.");
    return res.redirect("/admin/users");
  }

  if (user.id === req.currentUser.id) {
    setFlash(req, "error", "Use the normal forgot password flow to reset your own password.");
    return res.redirect("/admin/users");
  }

  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)").run(user.id, token, expiresAt);

  const base = getAppBaseUrl();
  const resetLink = `${base}/reset-password/${token}`;
  const displayRole = Number(user.is_superadmin) === 1 ? "superuser admin" : user.role;

  try {
    await sendSystemEmail({
      to: user.email,
      subject: "Manatee Password Reset",
      html: `<p>Your password reset was requested by an admin.</p><p><strong>Role:</strong> ${displayRole}</p><p><a href=\"${resetLink}\">Reset your password</a></p><p>This link expires in 1 hour.</p>`,
      text: `Your password reset was requested by an admin.\nRole: ${displayRole}\nReset your password here: ${resetLink}\nThis link expires in 1 hour.`,
      eventType: "admin_reset_password_requested",
      actorUserId: req.currentUser.id,
    });
    setFlash(req, "success", `Password reset email sent to ${user.email}.`);
  } catch (err) {
    setFlash(req, "error", `Reset link created, but email failed: ${String(err?.message || err)}`);
  }

  return res.redirect("/admin/users");
});

router.get("/users/:id/edit", (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    setFlash(req, "error", "Invalid user.");
    return res.redirect("/admin/users");
  }

  const user = db
    .prepare("SELECT id, email, role, is_superadmin, title, pronouns, first_name, surname, job_title, phone FROM users WHERE id = ?")
    .get(userId);

  if (!user) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }

  if (Number(user.is_superadmin) === 1) {
    setFlash(req, "error", "The superuser account cannot be edited.");
    return res.redirect("/admin/users");
  }

  if (user.role === "admin" && !req.currentUser.is_superadmin) {
    setFlash(req, "error", "Only the superuser can edit admin accounts.");
    return res.redirect("/admin/users");
  }

  return res.render("admin/user-edit", {
    title: "Edit User",
    user,
  });
});

router.post("/users/:id", (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    setFlash(req, "error", "Invalid user.");
    return res.redirect("/admin/users");
  }

  const user = db.prepare("SELECT id, role, is_superadmin FROM users WHERE id = ?").get(userId);
  if (!user) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }

  if (Number(user.is_superadmin) === 1) {
    setFlash(req, "error", "The superuser account cannot be edited.");
    return res.redirect("/admin/users");
  }

  if (user.role === "admin" && !req.currentUser.is_superadmin) {
    setFlash(req, "error", "Only the superuser can edit admin accounts.");
    return res.redirect("/admin/users");
  }

  const title = String(req.body.title || "").trim() || null;
  const pronouns = String(req.body.pronouns || "").trim() || null;
  const firstName = String(req.body.first_name || "").trim() || null;
  const surname = String(req.body.surname || "").trim() || null;
  const jobTitle = String(req.body.job_title || "").trim() || null;
  const phone = String(req.body.phone || "").trim() || null;
  const role = String(req.body.role || "").trim();
  const validRoles = ["admin", "mentor", "mentee", "both"];

  if (!validRoles.includes(role)) {
    setFlash(req, "error", "Invalid role.");
    return res.redirect(`/admin/users/${userId}/edit`);
  }

  db.prepare(
    "UPDATE users SET title = ?, pronouns = ?, first_name = ?, surname = ?, job_title = ?, phone = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(title, pronouns, firstName, surname, jobTitle, phone, role, userId);

  setFlash(req, "success", "User updated.");
  return res.redirect("/admin/users");
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

  const user = db.prepare("SELECT id, email, role, is_superadmin FROM users WHERE id = ?").get(userId);
  if (!user) {
    setFlash(req, "error", "User not found.");
    return res.redirect("/admin/users");
  }

  if (Number(user.is_superadmin) === 1) {
    setFlash(req, "error", "The superuser account cannot be deleted.");
    return res.redirect("/admin/users");
  }

  if (user.role === "admin" && !req.currentUser.is_superadmin) {
    setFlash(req, "error", "Only the superuser can delete admin accounts.");
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

router.post("/locations/import", (req, res) => {
  uploadCsv.single("csv_file")(req, res, (err) => {
    if (err) {
      setFlash(req, "error", String(err.message || err));
      return res.redirect("/admin");
    }
    return importNamedListCsv(req, res, {
      tableName: "locations",
      label: "location(s)",
    });
  });
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

router.post("/sections/import", (req, res) => {
  uploadCsv.single("csv_file")(req, res, (err) => {
    if (err) {
      setFlash(req, "error", String(err.message || err));
      return res.redirect("/admin");
    }
    return importNamedListCsv(req, res, {
      tableName: "sections",
      label: "function(s)",
    });
  });
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

router.post("/end-reasons/import", (req, res) => {
  uploadCsv.single("csv_file")(req, res, (err) => {
    if (err) {
      setFlash(req, "error", String(err.message || err));
      return res.redirect("/admin");
    }
    return importNamedListCsv(req, res, {
      tableName: "end_reasons",
      label: "end reason(s)",
    });
  });
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

router.post("/settings/smtp", (req, res) => {
  const smtpUser = String(req.body.smtp_user || req.body.user || "").trim() || null;
  const smtpPassword = String(req.body.smtp_password || req.body.pass || "").trim() || null;
  const fromEmail = String(req.body.from_email || "").trim() || null;

  if (!fromEmail) {
    setFlash(req, "error", "From Email is required.");
    return res.redirect("/admin/settings");
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
  return res.redirect("/admin/settings");
});

router.post("/settings/web-url", (req, res) => {
  const raw = String(req.body.base_url || "").trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let normalized;
  try {
    const parsed = new URL(withProtocol);
    normalized = parsed.origin.replace(/\/$/, "");
  } catch {
    setFlash(req, "error", "Invalid hosted URL. Example: https://manatee.example.com");
    return res.redirect("/admin/settings");
  }

  db.prepare("UPDATE smtp_settings SET base_url = ? WHERE id = 1").run(normalized);
  setFlash(req, "success", "Hosted URL updated.");
  return res.redirect("/admin/settings");
});

router.post("/settings/smtp/test", async (req, res) => {
  const testTo = String(req.body.test_to || "").trim() || req.currentUser.email;

  try {
    const testResult = await testSmtpDelivery({ to: testTo });

    if (!testResult.ok) {
      db.prepare(
        `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
         VALUES ('smtp_test', 'failed', ?, 'Manatee SMTP Test', ?, ?)`
      ).run(testTo, testResult.message, req.currentUser.id);

      setFlash(req, "error", `SMTP test failed: ${testResult.message}`);
      return res.redirect("/admin/settings");
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
    return res.redirect("/admin/settings");
  } catch (err) {
    db.prepare(
      `INSERT INTO email_audit_logs (event_type, status, recipient_email, subject, error_message, actor_user_id)
       VALUES ('smtp_test', 'failed', ?, 'Manatee SMTP Test', ?, ?)`
    ).run(testTo, String(err?.message || err), req.currentUser.id);

    setFlash(req, "error", `SMTP test failed: ${String(err?.message || err)}`);
    return res.redirect("/admin/settings");
  }
});

router.post("/smtp", (_req, res) => res.redirect(307, "/admin/settings/smtp"));
router.post("/smtp/test", (_req, res) => res.redirect(307, "/admin/settings/smtp/test"));

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
