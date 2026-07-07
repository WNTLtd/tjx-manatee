require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const { initializeDatabase } = require("./db");
const { attachAuthContext } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const mentorRoutes = require("./routes/mentor");
const menteeRoutes = require("./routes/mentee");
const profileRoutes = require("./routes/profile");

initializeDatabase();

const app = express();
const trustProxy = String(process.env.TRUST_PROXY || "0").trim();
if (trustProxy && trustProxy !== "0" && trustProxy.toLowerCase() !== "false") {
  app.set("trust proxy", 1);
}

const cookieSecure = String(process.env.SESSION_COOKIE_SECURE || "false").trim().toLowerCase() === "true";
const cookieSameSite = String(process.env.SESSION_COOKIE_SAMESITE || "lax").trim().toLowerCase();
const allowedSameSite = ["lax", "strict", "none"];

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "development_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: allowedSameSite.includes(cookieSameSite) ? cookieSameSite : "lax",
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));
app.use(attachAuthContext);

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "Manatee" });
});

app.get("/", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  if (req.currentUser.role === "admin") return res.redirect("/admin");
  if (["mentor", "both"].includes(req.currentUser.role)) return res.redirect("/mentor");
  return res.redirect("/mentee");
});

app.use(authRoutes);
app.use("/admin", adminRoutes);
app.use("/mentor", mentorRoutes);
app.use("/mentee", menteeRoutes);
app.use("/profile", profileRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).render("error", {
    title: "Error",
    message: "Something went wrong.",
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Manatee running on http://localhost:${port}`);
});
