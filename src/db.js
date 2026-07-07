const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { parseMentorshipGoalLog } = require("./utils/mentorshipGoals");

const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "manatee.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const THEME_DEFAULTS = {
  bg_color: "#f5f5f4",
  paper_color: "#ffffff",
  ink_color: "#1f1f1f",
  accent_color: "#c8102e",
  accent_2_color: "#8a8f98",
  danger_color: "#a6102a",
  warning_color: "#8c5a00",
  muted_color: "#5a5f66",
  line_color: "#d9dde2",
  bg_soft_color: "#eceff2",
  header_start_color: "#f7f8fa",
  header_end_color: "#eceff2",
  field_border_color: "#c8cdd3",
  surface_color: "#ffffff",
  btn_text_color: "#ffffff",
  btn_disabled_bg_color: "#b9bec7",
  btn_disabled_text_color: "#f5f6f8",
  flash_success_bg_color: "#e8f5ee",
  flash_success_text_color: "#1f6b43",
  flash_error_bg_color: "#fdecee",
  flash_error_text_color: "#8f1d2f",
  danger_soft_color: "#f3c9cf",
  goal_badge_color: "#0057ff",
};

function initializeDatabase() {
  repairBrokenUserForeignKeys();
  migrateUsersRoleConstraintForBoth();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin', 'mentor', 'mentee', 'both')),
      is_superadmin INTEGER NOT NULL DEFAULT 0,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      twofa_enabled INTEGER NOT NULL DEFAULT 0,
      twofa_secret TEXT,
      title TEXT,
      pronouns TEXT,
      first_name TEXT,
      surname TEXT,
      job_title TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS end_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS mentor_profiles (
      user_id INTEGER PRIMARY KEY,
      location_id INTEGER,
      available INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );

    CREATE TABLE IF NOT EXISTS mentee_profiles (
      user_id INTEGER PRIMARY KEY,
      location_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );

    CREATE TABLE IF NOT EXISTS mentor_sections (
      mentor_id INTEGER NOT NULL,
      section_id INTEGER NOT NULL,
      PRIMARY KEY (mentor_id, section_id),
      FOREIGN KEY (mentor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mentorships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      mentee_id INTEGER NOT NULL,
      section_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'ended')),
      mentor_message TEXT,
      goals_log TEXT,
      mentor_goals_seen_count INTEGER NOT NULL DEFAULT 0,
      mentee_goals_seen_count INTEGER NOT NULL DEFAULT 0,
      end_reason_id INTEGER,
      ended_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (mentor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mentee_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES sections(id),
      FOREIGN KEY (end_reason_id) REFERENCES end_reasons(id),
      FOREIGN KEY (ended_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS smtp_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      host TEXT,
      port INTEGER,
      secure INTEGER NOT NULL DEFAULT 0,
      user TEXT,
      pass TEXT,
      from_email TEXT,
      bcc_email TEXT
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_change_recoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      old_email TEXT NOT NULL,
      new_email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
      recipient_email TEXT,
      subject TEXT,
      error_message TEXT,
      actor_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // On a fresh database, create base tables first, then run additive column migrations.
  ensureUserNameColumns();
  ensureUsersSuperAdminColumn();
  ensureUsersTwoFactorColumns();
  ensureMentorshipGoalsLogColumn();
  ensureMentorshipGoalReadColumns();

  const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' AND email='admin'").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync("admin", 10);
    db.prepare("INSERT INTO users (role, is_superadmin, email, password_hash) VALUES ('admin', 1, 'admin', ?)").run(hash);
  }

  // Ensure the default seeded admin remains the superuser.
  db.prepare("UPDATE users SET is_superadmin = 1 WHERE role='admin' AND email='admin'").run();

  const defaultLocations = ["Sydney", "Melbourne", "Perth"];
  const insertLocation = db.prepare("INSERT OR IGNORE INTO locations (name) VALUES (?)");
  for (const item of defaultLocations) insertLocation.run(item);

  const defaultSections = ["Engineering", "Operations", "Sales", "People"];
  const insertSection = db.prepare("INSERT OR IGNORE INTO sections (name) VALUES (?)");
  for (const item of defaultSections) insertSection.run(item);

  const defaultReasons = ["Mentorship Completed", "Mentor Not Suitable", "Other"];
  const insertReason = db.prepare("INSERT OR IGNORE INTO end_reasons (name) VALUES (?)");
  for (const item of defaultReasons) insertReason.run(item);

  // Ensure role-compatible profile rows exist for pre-existing users.
  db.prepare(
    `INSERT OR IGNORE INTO mentor_profiles (user_id, available)
     SELECT id, 1 FROM users WHERE role IN ('mentor', 'both')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO mentee_profiles (user_id)
     SELECT id FROM users WHERE role IN ('mentee', 'both')`
  ).run();

  db.prepare("INSERT OR IGNORE INTO smtp_settings (id, secure) VALUES (1, 0)").run();
  ensureSiteSettingsTable();
}

function ensureSiteSettingsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bg_color TEXT NOT NULL DEFAULT '#f5f5f4',
      paper_color TEXT NOT NULL DEFAULT '#ffffff',
      ink_color TEXT NOT NULL DEFAULT '#1f1f1f',
      accent_color TEXT NOT NULL DEFAULT '#c8102e',
      accent_2_color TEXT NOT NULL DEFAULT '#8a8f98',
      danger_color TEXT NOT NULL DEFAULT '#a6102a',
      warning_color TEXT NOT NULL DEFAULT '#8c5a00',
      muted_color TEXT NOT NULL DEFAULT '#5a5f66',
      line_color TEXT NOT NULL DEFAULT '#d9dde2',
      bg_soft_color TEXT NOT NULL DEFAULT '#eceff2',
      header_start_color TEXT NOT NULL DEFAULT '#f7f8fa',
      header_end_color TEXT NOT NULL DEFAULT '#eceff2',
      field_border_color TEXT NOT NULL DEFAULT '#c8cdd3',
      surface_color TEXT NOT NULL DEFAULT '#ffffff',
      btn_text_color TEXT NOT NULL DEFAULT '#ffffff',
      btn_disabled_bg_color TEXT NOT NULL DEFAULT '#b9bec7',
      btn_disabled_text_color TEXT NOT NULL DEFAULT '#f5f6f8',
      flash_success_bg_color TEXT NOT NULL DEFAULT '#e8f5ee',
      flash_success_text_color TEXT NOT NULL DEFAULT '#1f6b43',
      flash_error_bg_color TEXT NOT NULL DEFAULT '#fdecee',
      flash_error_text_color TEXT NOT NULL DEFAULT '#8f1d2f',
      danger_soft_color TEXT NOT NULL DEFAULT '#f3c9cf',
      goal_badge_color TEXT NOT NULL DEFAULT '#0057ff',
      logo_path TEXT
    );
  `);

  const columns = db.prepare("PRAGMA table_info(site_settings)").all();
  const names = new Set(columns.map((col) => col.name));

  for (const [column, value] of Object.entries(THEME_DEFAULTS)) {
    if (!names.has(column)) {
      const literal = `'${String(value).replace(/'/g, "''")}'`;
      db.exec(`ALTER TABLE site_settings ADD COLUMN ${column} TEXT NOT NULL DEFAULT ${literal}`);
    }
  }

  if (!names.has("logo_path")) {
    db.prepare("ALTER TABLE site_settings ADD COLUMN logo_path TEXT").run();
  }

  const existing = db.prepare("SELECT id FROM site_settings WHERE id = 1").get();
  if (!existing) {
    db.prepare(
      `INSERT INTO site_settings (
        id, bg_color, paper_color, ink_color, accent_color, accent_2_color,
        danger_color, warning_color, muted_color, line_color, bg_soft_color,
        header_start_color, header_end_color, field_border_color, surface_color,
        btn_text_color, btn_disabled_bg_color, btn_disabled_text_color,
        flash_success_bg_color, flash_success_text_color,
        flash_error_bg_color, flash_error_text_color, danger_soft_color,
        goal_badge_color
      ) VALUES (
        1, @bg_color, @paper_color, @ink_color, @accent_color, @accent_2_color,
        @danger_color, @warning_color, @muted_color, @line_color, @bg_soft_color,
        @header_start_color, @header_end_color, @field_border_color, @surface_color,
        @btn_text_color, @btn_disabled_bg_color, @btn_disabled_text_color,
        @flash_success_bg_color, @flash_success_text_color,
        @flash_error_bg_color, @flash_error_text_color, @danger_soft_color,
        @goal_badge_color
      )`
    ).run(THEME_DEFAULTS);
  }
}

function getSiteSettings() {
  const row = db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  return { ...THEME_DEFAULTS, ...row };
}

function migrateUsersRoleConstraintForBoth() {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    .get();

  if (!table || !table.sql || table.sql.includes("'both'")) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin', 'mentor', 'mentee', 'both')),
      is_superadmin INTEGER NOT NULL DEFAULT 0,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      twofa_enabled INTEGER NOT NULL DEFAULT 0,
      twofa_secret TEXT,
      title TEXT,
      pronouns TEXT,
      first_name TEXT,
      surname TEXT,
      job_title TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users_new (id, role, is_superadmin, email, password_hash, twofa_enabled, twofa_secret, title, pronouns, first_name, surname, job_title, created_at, updated_at)
    SELECT id, role, 0, email, password_hash, 0, NULL, NULL, NULL, NULL, NULL, NULL, created_at, updated_at
    FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureUserNameColumns() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const names = columns.map((col) => col.name);

  if (!names.includes("title")) {
    db.prepare("ALTER TABLE users ADD COLUMN title TEXT").run();
  }
  if (!names.includes("pronouns")) {
    db.prepare("ALTER TABLE users ADD COLUMN pronouns TEXT").run();
  }
  if (!names.includes("first_name")) {
    db.prepare("ALTER TABLE users ADD COLUMN first_name TEXT").run();
  }
  if (!names.includes("surname")) {
    db.prepare("ALTER TABLE users ADD COLUMN surname TEXT").run();
  }
  if (!names.includes("job_title")) {
    db.prepare("ALTER TABLE users ADD COLUMN job_title TEXT").run();
  }
}

function ensureUsersSuperAdminColumn() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const names = columns.map((col) => col.name);

  if (!names.includes("is_superadmin")) {
    db.prepare("ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0").run();
  }

  const superCount = Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND is_superadmin = 1").get().c);
  if (superCount > 0) return;

  const defaultAdmin = db.prepare("SELECT id FROM users WHERE role='admin' AND email='admin' ORDER BY id ASC LIMIT 1").get();
  if (defaultAdmin) {
    db.prepare("UPDATE users SET is_superadmin = 1 WHERE id = ?").run(defaultAdmin.id);
    return;
  }

  const firstAdmin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1").get();
  if (firstAdmin) {
    db.prepare("UPDATE users SET is_superadmin = 1 WHERE id = ?").run(firstAdmin.id);
  }
}

function ensureUsersTwoFactorColumns() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const names = columns.map((col) => col.name);

  if (!names.includes("twofa_enabled")) {
    db.prepare("ALTER TABLE users ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0").run();
  }

  if (!names.includes("twofa_secret")) {
    db.prepare("ALTER TABLE users ADD COLUMN twofa_secret TEXT").run();
  }
}

function ensureMentorshipGoalsLogColumn() {
  const columns = db.prepare("PRAGMA table_info(mentorships)").all();
  const names = columns.map((col) => col.name);

  if (!names.includes("goals_log")) {
    db.prepare("ALTER TABLE mentorships ADD COLUMN goals_log TEXT").run();
  }
}

function ensureMentorshipGoalReadColumns() {
  const columns = db.prepare("PRAGMA table_info(mentorships)").all();
  const names = columns.map((col) => col.name);

  if (!names.includes("mentor_goals_seen_count")) {
    db.prepare("ALTER TABLE mentorships ADD COLUMN mentor_goals_seen_count INTEGER NOT NULL DEFAULT 0").run();
  }

  if (!names.includes("mentee_goals_seen_count")) {
    db.prepare("ALTER TABLE mentorships ADD COLUMN mentee_goals_seen_count INTEGER NOT NULL DEFAULT 0").run();
  }

  const mentorships = db.prepare("SELECT id, goals_log FROM mentorships").all();
  const update = db.prepare(
    `UPDATE mentorships
     SET mentor_goals_seen_count = ?, mentee_goals_seen_count = ?
     WHERE id = ?`
  );

  for (const mentorship of mentorships) {
    const totalEntries = parseMentorshipGoalLog(mentorship.goals_log).length;
    update.run(totalEntries, totalEntries, mentorship.id);
  }
}

function tableHasUsersOldForeignKey(tableName) {
  const fks = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all();
  return fks.some((fk) => fk.table === "users_old");
}

function repairBrokenUserForeignKeys() {
  const targetTables = [
    "mentor_profiles",
    "mentee_profiles",
    "mentor_sections",
    "mentorships",
    "password_resets",
  ];

  const hasBroken = targetTables.some((tableName) => tableHasUsersOldForeignKey(tableName));
  if (!hasBroken) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;

    ALTER TABLE mentor_profiles RENAME TO mentor_profiles_old;
    CREATE TABLE mentor_profiles (
      user_id INTEGER PRIMARY KEY,
      location_id INTEGER,
      available INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
    INSERT INTO mentor_profiles (user_id, location_id, available)
    SELECT user_id, location_id, available FROM mentor_profiles_old;
    DROP TABLE mentor_profiles_old;

    ALTER TABLE mentee_profiles RENAME TO mentee_profiles_old;
    CREATE TABLE mentee_profiles (
      user_id INTEGER PRIMARY KEY,
      location_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
    INSERT INTO mentee_profiles (user_id, location_id)
    SELECT user_id, location_id FROM mentee_profiles_old;
    DROP TABLE mentee_profiles_old;

    ALTER TABLE mentor_sections RENAME TO mentor_sections_old;
    CREATE TABLE mentor_sections (
      mentor_id INTEGER NOT NULL,
      section_id INTEGER NOT NULL,
      PRIMARY KEY (mentor_id, section_id),
      FOREIGN KEY (mentor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
    );
    INSERT INTO mentor_sections (mentor_id, section_id)
    SELECT mentor_id, section_id FROM mentor_sections_old;
    DROP TABLE mentor_sections_old;

    ALTER TABLE mentorships RENAME TO mentorships_old;
    CREATE TABLE mentorships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id INTEGER NOT NULL,
      mentee_id INTEGER NOT NULL,
      section_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'ended')),
      mentor_message TEXT,
      goals_log TEXT,
      mentor_goals_seen_count INTEGER NOT NULL DEFAULT 0,
      mentee_goals_seen_count INTEGER NOT NULL DEFAULT 0,
      end_reason_id INTEGER,
      ended_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (mentor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mentee_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES sections(id),
      FOREIGN KEY (end_reason_id) REFERENCES end_reasons(id),
      FOREIGN KEY (ended_by_user_id) REFERENCES users(id)
    );
    INSERT INTO mentorships (
      id, mentor_id, mentee_id, section_id, status, mentor_message, goals_log,
      mentor_goals_seen_count, mentee_goals_seen_count,
      end_reason_id, ended_by_user_id, created_at, updated_at
    )
    SELECT
      id, mentor_id, mentee_id, section_id, status, mentor_message, goals_log,
      0, 0,
      end_reason_id, ended_by_user_id, created_at, updated_at
    FROM mentorships_old;
    DROP TABLE mentorships_old;

    ALTER TABLE password_resets RENAME TO password_resets_old;
    CREATE TABLE password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO password_resets (id, user_id, token, expires_at, used, created_at)
    SELECT id, user_id, token, expires_at, used, created_at FROM password_resets_old;
    DROP TABLE password_resets_old;

    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

module.exports = {
  db,
  initializeDatabase,
  THEME_DEFAULTS,
  getSiteSettings,
};
