
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pool = require("./db");

const {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Required configuration
const requiredEnv = [
  "SESSION_SECRET",
  "B2_BUCKET_NAME",
  "B2_ENDPOINT",
  "B2_REGION",
  "B2_KEY_ID",
  "B2_APPLICATION_KEY"
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`${name} is missing from .env`);
  }
}

// Backblaze B2 S3-compatible client
const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  }
});

const BUCKET = process.env.B2_BUCKET_NAME;

app.disable("x-powered-by");

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const b2Origin = new URL(process.env.B2_ENDPOINT).origin;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "data:"
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        b2Origin
      ],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Persistent PostgreSQL sessions
app.use(session({
  store: new PgSession({
    pool,
    tableName: "session",
    createTableIfMissing: false
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

// Authentication
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Please sign in first."
    });
  }

  next();
}

// Game clients use short-lived one-time website codes, then a revocable token.
async function requireGameAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{32,})$/i);
    if (!match) {
      return res.status(401).json({ error: "Connect your NEON GAMES account first." });
    }

    const tokenHash = crypto.createHash("sha256").update(match[1]).digest("hex");
    const result = await pool.query(
      `SELECT t.user_id
       FROM public.game_api_tokens t
       JOIN public.users u ON u.id = t.user_id
       WHERE t.token_hash = $1
         AND t.revoked_at IS NULL
         AND t.expires_at > NOW()`,
      [tokenHash]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Game session expired. Link your account again." });
    }

    req.gameUserId = result.rows[0].user_id;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        error: "Please sign in first."
      });
    }

    const result = await pool.query(
      "SELECT role FROM public.users WHERE id = $1",
      [req.session.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Please sign in first."
      });
    }

    if (result.rows[0].role !== "admin") {
      return res.status(403).json({
        error: "Admin access only."
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

function safeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    created_at: user.created_at
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55) || "game";
}

function getBattlePassPrice() {
  const configured = Number(process.env.BATTLE_PASS_PRICE_DIAMONDS || 500);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 1000000
    ? configured
    : 500;
}

function establishSession(req, userId, res, user) {
  req.session.regenerate((error) => {
    if (error) {
      return res.status(500).json({
        error: "Could not create session."
      });
    }

    req.session.userId = userId;

    req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).json({
          error: "Could not save session."
        });
      }

      res.json({
        user: safeUser(user)
      });
    });
  });
}

// B2 helpers
async function createDownloadUrl(key, filename, contentType) {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition:
      `attachment; filename="${filename.replace(/["\\]/g, "_")}"`,
    ...(contentType
      ? { ResponseContentType: contentType }
      : {})
  });

  return getSignedUrl(s3, command, {
    expiresIn: 15 * 60
  });
}

async function createCoverUrl(key) {
  if (!key) return null;

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key
    }),
    { expiresIn: 60 * 60 }
  );
}

async function createProofUrl(key) {
  if (!key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 15 * 60 });
}

async function publicGame(game) {
  return {
    id: game.id,
    title: game.title,
    slug: game.slug,
    description: game.description,
    platform: game.platform,
    version: game.version,
    cover: await createCoverUrl(game.cover_key),
    hasWindows: !!game.windows_key,
    hasAndroid: !!game.android_key,
    featured: !!game.featured,
    downloads: Number(game.downloads || 0),
    createdAt: game.created_at,
    updatedAt: game.updated_at
  };
}

async function deleteB2Object(key) {
  if (!key) return;

  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key
  }));
}

function cleanupLocalFiles(files) {
  for (const file of files || []) {
    if (file && file.path) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch (error) {
        console.error("Temporary file cleanup failed:", error.message);
      }
    }
  }
}

async function uploadToB2(file, folder = "games") {
  const key = `${folder}/${file.filename}`;

  const uploader = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(file.path),
      ContentType: file.mimetype || "application/octet-stream"
    },
    partSize: 10 * 1024 * 1024,
    queueSize: 3,
    leavePartsOnError: false
  });

  await uploader.done();

  return key;
}

// Temporary upload storage
const allowedGameExt = new Set([
  ".zip",
  ".7z",
  ".exe",
  ".msi",
  ".apk"
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    cb(
      null,
      `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`
    );
  }
});

const maxBytes =
  Math.max(1, Number(process.env.MAX_GAME_FILE_MB || 2048)) *
  1024 * 1024;

const upload = multer({
  storage,
  limits: {
    fileSize: maxBytes,
    files: 3
  },

  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (file.fieldname === "cover") {
      if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
        return cb(new Error("Cover must be JPG, PNG or WEBP."));
      }

      return cb(null, true);
    }

    if (file.fieldname === "proof") {
      if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
        return cb(new Error("Payment proof must be JPG, PNG or WEBP."));
      }
      return cb(null, true);
    }

    if (!allowedGameExt.has(ext)) {
      return cb(new Error("Game file must be ZIP, 7Z, EXE, MSI or APK."));
    }

    cb(null, true);
  }
});

const proofUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      return cb(new Error("Payment proof must be JPG, PNG or WEBP."));
    }
    cb(null, true);
  }
});

// Health check
app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      name: "NEON GAMES",
      database: "connected",
      storage: "Backblaze B2"
    });
  } catch (error) {
    next(error);
  }
});

// Current user
app.get("/api/me", async (req, res, next) => {
  try {
    if (!req.session.userId) {
      return res.json({ user: null });
    }

    const result = await pool.query(
      `SELECT id, username, email, role, created_at
       FROM public.users WHERE id = $1`,
      [req.session.userId]
    );

    res.json({
      user: result.rows[0]
        ? safeUser(result.rows[0])
        : null
    });
  } catch (error) {
    next(error);
  }
});

// Registration: new accounts are regular users
app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (username.length < 3 || username.length > 24) {
      return res.status(400).json({
        error: "Username must be 3-24 characters."
      });
    }

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 190
    ) {
      return res.status(400).json({
        error: "Enter a valid email address."
      });
    }

    if (password.length < 10 || password.length > 72) {
      return res.status(400).json({
        error: "Password must be 10-72 characters."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO public.users
       (username, email, password_hash, role)
       VALUES ($1, $2, $3, 'user')
       RETURNING id, username, email, role, created_at`,
      [username, email, passwordHash]
    );

    establishSession(req, result.rows[0].id, res, result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "This email or username is already registered."
      });
    }

    next(error);
  }
});

// Login
app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, username, email, password_hash, role, created_at
       FROM public.users WHERE LOWER(email) = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Email or password is incorrect."
      });
    }

    establishSession(req, user.id, res, user);
  } catch (error) {
    next(error);
  }
});

// Logout
app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        error: "Could not sign out."
      });
    }

    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// Public game list
app.get("/api/games", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM public.games
       ORDER BY featured DESC, created_at DESC`
    );

    const games = await Promise.all(
      result.rows.map(publicGame)
    );

    res.json({ games });
  } catch (error) {
    next(error);
  }
});

// Single game
app.get("/api/games/:slug", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM public.games WHERE slug = $1",
      [req.params.slug]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Game not found."
      });
    }

    res.json({
      game: await publicGame(result.rows[0])
    });
  } catch (error) {
    next(error);
  }
});

// Download from private B2 bucket
app.get("/api/games/:id/download/:platform", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const platform = req.params.platform;

    if (
      !Number.isInteger(id) ||
      !["windows", "android"].includes(platform)
    ) {
      return res.status(400).send("Invalid download.");
    }

    const result = await pool.query(
      "SELECT * FROM public.games WHERE id = $1",
      [id]
    );

    const game = result.rows[0];

    if (!game) {
      return res.status(404).send("Game not found.");
    }

    const key =
      platform === "windows"
        ? game.windows_key
        : game.android_key;

    if (!key) {
      return res.status(404).send(
        "This version is not available yet."
      );
    }

    const extension = path.extname(key) || "";
    const filename = `${game.slug}-${platform}${extension}`;

    const url = await createDownloadUrl(
      key,
      filename,
      "application/octet-stream"
    );

    await pool.query(
      "UPDATE public.games SET downloads = downloads + 1 WHERE id = $1",
      [id]
    );

    await pool.query(
      `INSERT INTO public.downloads (game_id, platform)
       VALUES ($1, $2)`,
      [id, platform]
    );

    res.redirect(302, url);
  } catch (error) {
    next(error);
  }
});

// NEON Diamonds wallet
app.get("/api/wallet", requireAuth, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const [user, transactions, requests] = await Promise.all([
      pool.query("SELECT diamonds FROM public.users WHERE id = $1", [req.session.userId]),
      pool.query(
        `SELECT id, entry_type, amount, balance_after, description, created_at
         FROM public.wallet_transactions WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 20`, [req.session.userId]
      ),
      pool.query(
        `SELECT id, amount_tnd, status, admin_note, created_at, reviewed_at
         FROM public.diamond_recharge_requests WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 10`, [req.session.userId]
      )
    ]);

    res.json({
      diamonds: Number(user.rows[0]?.diamonds || 0),
      transactions: transactions.rows,
      requests: requests.rows,
      d17: {
        enabled: process.env.ENABLE_D17_RECHARGE === "true",
        receiverName: process.env.D17_RECEIVER_NAME || "",
        receiverPhone: process.env.D17_RECEIVER_PHONE || "",
        instructions: process.env.D17_INSTRUCTIONS || "Contact NEON GAMES support for D17 payment instructions."
      }
    });
  } catch (error) { next(error); }
});

// Manual D17 proof submission (disabled until ENABLE_D17_RECHARGE=true).
app.post("/api/wallet/recharge", requireAuth, authLimiter, proofUpload.single("proof"), async (req, res, next) => {
  const file = req.file;
  try {
    if (process.env.ENABLE_D17_RECHARGE !== "true") {
      cleanupLocalFiles(file ? [file] : []);
      return res.status(403).json({ error: "D17 recharges are not enabled yet." });
    }

    const amountTnd = Number(req.body.amountTnd);
    if (!Number.isFinite(amountTnd) || amountTnd < 1 || amountTnd > 1000 || !file) {
      cleanupLocalFiles(file ? [file] : []);
      return res.status(400).json({ error: "Enter an amount from 1 to 1000 TND and attach a payment proof." });
    }

    const proofKey = await uploadToB2(file, "wallet-proofs");
    try {
      const result = await pool.query(
        `INSERT INTO public.diamond_recharge_requests (user_id, amount_tnd, proof_key)
         VALUES ($1, $2, $3)
         RETURNING id, amount_tnd, status, created_at`,
        [req.session.userId, amountTnd.toFixed(3), proofKey]
      );
      res.status(201).json({ request: result.rows[0] });
    } catch (databaseError) {
      await deleteB2Object(proofKey).catch(() => {});
      if (databaseError.code === "23505") {
        return res.status(409).json({ error: "You already have a pending D17 recharge request." });
      }
      throw databaseError;
    }
  } catch (error) { next(error); }
  finally { cleanupLocalFiles(file ? [file] : []); }
});

// One-time website-to-game pairing code.
app.post("/api/game/link-code", requireAuth, authLimiter, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    await pool.query(
      `INSERT INTO public.game_login_codes (code_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [codeHash, req.session.userId]
    );
    res.json({ code, expiresInSeconds: 300 });
  } catch (error) { next(error); }
});

app.post("/api/game/exchange-code", authLimiter, async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const code = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
    return res.status(400).json({ error: "Enter the 8-character code shown on your website account." });
  }

  const client = await pool.connect();
  try {
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT user_id FROM public.game_login_codes
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       FOR UPDATE`, [codeHash]
    );
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Code invalid, expired or already used." });
    }
    const userId = found.rows[0].user_id;
    await client.query("UPDATE public.game_login_codes SET used_at = NOW() WHERE code_hash = $1", [codeHash]);
    await client.query(
      `INSERT INTO public.game_player_profiles (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]
    );
    await client.query(
      `INSERT INTO public.game_api_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '90 days')`, [tokenHash, userId]
    );
    const account = await client.query(
      `SELECT u.username, u.diamonds, p.xp, p.pass_level, p.premium_pass
       FROM public.users u JOIN public.game_player_profiles p ON p.user_id = u.id
       WHERE u.id = $1`, [userId]
    );
    await client.query("COMMIT");
    res.json({ token: rawToken, expiresInDays: 90, account: account.rows[0] });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    next(error);
  } finally { client.release(); }
});

app.get("/api/game/profile", requireGameAuth, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    await pool.query(
      `INSERT INTO public.game_player_profiles (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [req.gameUserId]
    );
    const result = await pool.query(
      `SELECT u.id, u.username, u.diamonds, p.xp, p.pass_level, p.premium_pass, p.season_id
       FROM public.users u JOIN public.game_player_profiles p ON p.user_id = u.id
       WHERE u.id = $1`, [req.gameUserId]
    );
    res.json({ profile: { ...result.rows[0], battlePassPriceDiamonds: getBattlePassPrice() } });
  } catch (error) { next(error); }
});

app.post("/api/game/logout", requireGameAuth, async (req, res, next) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    await pool.query("UPDATE public.game_api_tokens SET revoked_at = NOW() WHERE token_hash = $1", [hash]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Premium pass purchase. Price is controlled by BATTLE_PASS_PRICE_DIAMONDS on the server.
app.post("/api/game/battle-pass/premium", requireGameAuth, async (req, res, next) => {
  const price = getBattlePassPrice();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query("SELECT diamonds FROM public.users WHERE id = $1 FOR UPDATE", [req.gameUserId]);
    const profile = await client.query("SELECT premium_pass, pass_level, season_id FROM public.game_player_profiles WHERE user_id = $1 FOR UPDATE", [req.gameUserId]);
    if (!user.rows.length || !profile.rows.length) throw new Error("Game profile not found.");
    if (profile.rows[0].premium_pass) {
      await client.query("COMMIT");
      return res.json({ ok: true, alreadyOwned: true, diamonds: Number(user.rows[0].diamonds) });
    }
    const balance = Number(user.rows[0].diamonds || 0);
    if (balance < price) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Not enough NEON Diamonds. Premium Pass costs ${price}.` });
    }
    const updated = await client.query(
      "UPDATE public.users SET diamonds = diamonds - $1 WHERE id = $2 RETURNING diamonds",
      [price, req.gameUserId]
    );
    await client.query(
      "UPDATE public.game_player_profiles SET premium_pass = TRUE, updated_at = NOW() WHERE user_id = $1",
      [req.gameUserId]
    );
    await client.query(
      `INSERT INTO public.wallet_transactions
       (user_id, entry_type, amount, balance_after, description, idempotency_key)
       VALUES ($1, 'battle_pass_purchase', $2, $3, 'Premium Battle Pass purchase', $4)`,
      [req.gameUserId, -price, Number(updated.rows[0].diamonds), `battlepass:${req.gameUserId}:${crypto.randomUUID()}`]
    );

    // If the player buys Premium after levelling up, grant the Premium track milestones already reached.
    let balanceAfter = Number(updated.rows[0].diamonds);
    const level = Number(profile.rows[0].pass_level);
    const season = profile.rows[0].season_id;
    for (const milestone of [2, 4, 6, 8, 10]) {
      if (level < milestone) continue;
      const reward = await client.query(
        `INSERT INTO public.game_pass_rewards (user_id, season_id, pass_level, reward_type, diamonds)
         VALUES ($1, $2, $3, 'premium', 15)
         ON CONFLICT (user_id, season_id, pass_level, reward_type) DO NOTHING
         RETURNING id`, [req.gameUserId, season, milestone]
      );
      if (reward.rows.length) {
        const credited = await client.query(
          "UPDATE public.users SET diamonds = diamonds + 15 WHERE id = $1 RETURNING diamonds", [req.gameUserId]
        );
        balanceAfter = Number(credited.rows[0].diamonds);
        await client.query(
          `INSERT INTO public.wallet_transactions
           (user_id, entry_type, amount, balance_after, description, idempotency_key)
           VALUES ($1, 'battle_pass_reward', 15, $2, $3, $4)`,
          [req.gameUserId, balanceAfter, `Premium Pass level ${milestone} reward`, `passreward:${req.gameUserId}:${season}:${milestone}:premium`]
        );
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true, premiumPass: true, diamonds: balanceAfter });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    next(error);
  } finally { client.release(); }
});

// Completed CPU matches grant a modest, daily-capped amount of Battle Pass XP.
// This is casual progression, not ranked/anti-cheat proof of a competitive result.
app.post("/api/game/match-complete", requireGameAuth, authLimiter, async (req, res, next) => {
  const matchId = String(req.body.matchId || "").trim();
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(matchId)) {
    return res.status(400).json({ error: "Invalid match identifier." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM public.users WHERE id = $1 FOR UPDATE", [req.gameUserId]);
    await client.query(
      `INSERT INTO public.game_player_profiles (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`, [req.gameUserId]
    );
    const profile = await client.query(
      "SELECT xp, pass_level, premium_pass, season_id FROM public.game_player_profiles WHERE user_id = $1 FOR UPDATE",
      [req.gameUserId]
    );
    const inserted = await client.query(
      `INSERT INTO public.game_xp_events (user_id, match_id, xp_awarded)
       VALUES ($1, $2, 0) ON CONFLICT (user_id, match_id) DO NOTHING RETURNING id`,
      [req.gameUserId, matchId]
    );
    if (!inserted.rows.length) {
      await client.query("COMMIT");
      return res.json({ ok: true, duplicate: true, xp: Number(profile.rows[0].xp), passLevel: Number(profile.rows[0].pass_level) });
    }
    const daily = await client.query(
      `SELECT COALESCE(SUM(xp_awarded), 0) AS earned
       FROM public.game_xp_events
       WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())`, [req.gameUserId]
    );
    const remaining = Math.max(0, 100 - Number(daily.rows[0].earned));
    const awarded = Math.min(20, remaining);
    await client.query("UPDATE public.game_xp_events SET xp_awarded = $1 WHERE id = $2", [awarded, inserted.rows[0].id]);
    const oldXp = Number(profile.rows[0].xp);
    const newXp = oldXp + awarded;
    const oldLevel = Number(profile.rows[0].pass_level);
    const newLevel = Math.min(10, 1 + Math.floor(newXp / 100));
    await client.query(
      "UPDATE public.game_player_profiles SET xp = $1, pass_level = $2, updated_at = NOW() WHERE user_id = $3",
      [newXp, newLevel, req.gameUserId]
    );

    let balanceAfter = null;
    const milestones = [2, 4, 6, 8, 10].filter(level => level > oldLevel && level <= newLevel);
    for (const milestone of milestones) {
      const reward = await client.query(
        `INSERT INTO public.game_pass_rewards (user_id, season_id, pass_level, reward_type, diamonds)
         VALUES ($1, $2, $3, 'free', 10)
         ON CONFLICT (user_id, season_id, pass_level, reward_type) DO NOTHING
         RETURNING id`, [req.gameUserId, profile.rows[0].season_id, milestone]
      );
      if (reward.rows.length) {
        const credited = await client.query(
          "UPDATE public.users SET diamonds = diamonds + 10 WHERE id = $1 RETURNING diamonds", [req.gameUserId]
        );
        balanceAfter = Number(credited.rows[0].diamonds);
        await client.query(
          `INSERT INTO public.wallet_transactions
           (user_id, entry_type, amount, balance_after, description, idempotency_key)
           VALUES ($1, 'battle_pass_reward', 10, $2, $3, $4)`,
          [req.gameUserId, balanceAfter, `Free Pass level ${milestone} reward`, `passreward:${req.gameUserId}:${profile.rows[0].season_id}:${milestone}:free`]
        );
      }
      if (profile.rows[0].premium_pass) {
        const premiumReward = await client.query(
          `INSERT INTO public.game_pass_rewards (user_id, season_id, pass_level, reward_type, diamonds)
           VALUES ($1, $2, $3, 'premium', 15)
           ON CONFLICT (user_id, season_id, pass_level, reward_type) DO NOTHING
           RETURNING id`, [req.gameUserId, profile.rows[0].season_id, milestone]
        );
        if (premiumReward.rows.length) {
          const credited = await client.query(
            "UPDATE public.users SET diamonds = diamonds + 15 WHERE id = $1 RETURNING diamonds", [req.gameUserId]
          );
          balanceAfter = Number(credited.rows[0].diamonds);
          await client.query(
            `INSERT INTO public.wallet_transactions
             (user_id, entry_type, amount, balance_after, description, idempotency_key)
             VALUES ($1, 'battle_pass_reward', 15, $2, $3, $4)`,
            [req.gameUserId, balanceAfter, `Premium Pass level ${milestone} reward`, `passreward:${req.gameUserId}:${profile.rows[0].season_id}:${milestone}:premium`]
          );
        }
      }
    }
    const wallet = await client.query("SELECT diamonds FROM public.users WHERE id = $1", [req.gameUserId]);
    await client.query("COMMIT");
    res.json({ ok: true, xpAwarded: awarded, xp: newXp, passLevel: newLevel, diamonds: Number(wallet.rows[0].diamonds), dailyXpRemaining: remaining - awarded });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    next(error);
  } finally { client.release(); }
});

// Admin wallet tools
app.post("/api/admin/wallet/grant", requireAdmin, async (req, res, next) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const amount = Math.floor(Number(req.body.diamonds));
  const description = String(req.body.description || "Admin wallet grant").trim().slice(0, 180);
  if (!email || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
    return res.status(400).json({ error: "Enter a valid player email and an amount from 1 to 1,000,000." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query("SELECT id, diamonds FROM public.users WHERE LOWER(email) = $1 FOR UPDATE", [email]);
    if (!user.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Player account not found." });
    }
    const updated = await client.query("UPDATE public.users SET diamonds = diamonds + $1 WHERE id = $2 RETURNING diamonds", [amount, user.rows[0].id]);
    await client.query(
      `INSERT INTO public.wallet_transactions
       (user_id, entry_type, amount, balance_after, description, created_by, idempotency_key)
       VALUES ($1, 'admin_grant', $2, $3, $4, $5, $6)`,
      [user.rows[0].id, amount, Number(updated.rows[0].diamonds), description || "Admin wallet grant", req.session.userId, `grant:${crypto.randomUUID()}`]
    );
    await client.query("COMMIT");
    res.json({ ok: true, diamonds: Number(updated.rows[0].diamonds) });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    next(error);
  } finally { client.release(); }
});

app.get("/api/admin/wallet/requests", requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.amount_tnd, r.status, r.proof_key, r.admin_note, r.created_at,
              u.username, u.email
       FROM public.diamond_recharge_requests r
       JOIN public.users u ON u.id = r.user_id
       WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT 100`
    );
    const requests = await Promise.all(result.rows.map(async row => ({
      ...row, proofUrl: await createProofUrl(row.proof_key)
    })));
    res.json({ requests });
  } catch (error) { next(error); }
});

app.post("/api/admin/wallet/requests/:id/review", requireAdmin, async (req, res, next) => {
  const status = String(req.body.status || "");
  const diamonds = Math.floor(Number(req.body.diamonds));
  const note = String(req.body.note || "").trim().slice(0, 300);
  if (!["approved", "rejected"].includes(status) || (status === "approved" && (!Number.isSafeInteger(diamonds) || diamonds < 1 || diamonds > 1000000))) {
    return res.status(400).json({ error: "Choose approve with a valid Diamonds amount, or reject." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query(
      "SELECT * FROM public.diamond_recharge_requests WHERE id = $1 FOR UPDATE", [req.params.id]
    );
    if (!request.rows.length || request.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This request is no longer pending." });
    }
    const row = request.rows[0];
    let balanceAfter = null;
    if (status === "approved") {
      const updated = await client.query(
        "UPDATE public.users SET diamonds = diamonds + $1 WHERE id = $2 RETURNING diamonds",
        [diamonds, row.user_id]
      );
      balanceAfter = Number(updated.rows[0].diamonds);
      await client.query(
        `INSERT INTO public.wallet_transactions
         (user_id, entry_type, amount, balance_after, description, created_by, idempotency_key)
         VALUES ($1, 'd17_recharge', $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [row.user_id, diamonds, balanceAfter, `D17 recharge request #${row.id}`, req.session.userId, `recharge:${row.id}`]
      );
    }
    await client.query(
      `UPDATE public.diamond_recharge_requests
       SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW(), credited_diamonds = $4
       WHERE id = $5`,
      [status, note || null, req.session.userId, status === "approved" ? diamonds : null, row.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, status, diamonds: balanceAfter });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    next(error);
  } finally { client.release(); }
});

// Admin statistics
app.get("/api/admin/stats", requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM public.users WHERE role = 'user') AS users,
        (SELECT COUNT(*) FROM public.games) AS games,
        (SELECT COALESCE(SUM(downloads), 0) FROM public.games) AS downloads
    `);

    res.json({
      users: Number(result.rows[0].users),
      games: Number(result.rows[0].games),
      downloads: Number(result.rows[0].downloads)
    });
  } catch (error) {
    next(error);
  }
});

// Admin game list
app.get("/api/admin/games", requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM public.games ORDER BY created_at DESC"
    );

    const games = await Promise.all(
      result.rows.map(publicGame)
    );

    res.json({ games });
  } catch (error) {
    next(error);
  }
});

// Admin publishes a game to B2
app.post(
  "/api/admin/games",
  requireAdmin,
  upload.fields([
    { name: "cover", maxCount: 1 },
    { name: "windowsFile", maxCount: 1 },
    { name: "androidFile", maxCount: 1 }
  ]),
  async (req, res, next) => {
    const files = req.files || {};
    const allFiles = Object.values(files).flat();
    const uploadedKeys = [];

    try {
      const title = String(req.body.title || "").trim();
      const description = String(req.body.description || "").trim();
      const version = String(req.body.version || "1.0.0")
        .trim()
        .slice(0, 30);

      const platform = [
        "windows",
        "android",
        "both"
      ].includes(req.body.platform)
        ? req.body.platform
        : "both";

      if (
        title.length < 2 ||
        title.length > 90 ||
        description.length < 10 ||
        description.length > 5000
      ) {
        cleanupLocalFiles(allFiles);

        return res.status(400).json({
          error: "Add a title (2-90 chars) and description (10-5000 chars)."
        });
      }

      if (!files.windowsFile?.[0] && !files.androidFile?.[0]) {
        cleanupLocalFiles(allFiles);

        return res.status(400).json({
          error: "Upload at least one game file."
        });
      }

      let slug = slugify(title);

      const existing = await pool.query(
        "SELECT 1 FROM public.games WHERE slug = $1",
        [slug]
      );

      if (existing.rows.length) {
        slug += "-" + crypto.randomBytes(3).toString("hex");
      }

      let coverKey = null;
      let windowsKey = null;
      let androidKey = null;

      if (files.cover?.[0]) {
        coverKey = await uploadToB2(files.cover[0]);
        uploadedKeys.push(coverKey);
      }

      if (files.windowsFile?.[0]) {
        windowsKey = await uploadToB2(files.windowsFile[0]);
        uploadedKeys.push(windowsKey);
      }

      if (files.androidFile?.[0]) {
        androidKey = await uploadToB2(files.androidFile[0]);
        uploadedKeys.push(androidKey);
      }

      const result = await pool.query(
        `INSERT INTO public.games
         (title, slug, description, platform, version,
          cover_key, windows_key, android_key, featured, downloads)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)
         RETURNING *`,
        [
          title,
          slug,
          description,
          platform,
          version,
          coverKey,
          windowsKey,
          androidKey,
          req.body.featured === "true"
        ]
      );

      res.status(201).json({
        game: await publicGame(result.rows[0])
      });
    } catch (error) {
      for (const key of uploadedKeys) {
        try {
          await deleteB2Object(key);
        } catch (deleteError) {
          console.error(
            "B2 rollback cleanup failed:",
            deleteError.message
          );
        }
      }

      next(error);
    } finally {
      cleanupLocalFiles(allFiles);
    }
  }
);

// Admin deletes game and its B2 files
app.delete("/api/admin/games/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM public.games WHERE id = $1",
      [req.params.id]
    );

    const game = result.rows[0];

    if (!game) {
      return res.status(404).json({
        error: "Game not found."
      });
    }

    const keys = [
      game.cover_key,
      game.windows_key,
      game.android_key
    ].filter(Boolean);

    // Delete B2 objects first. If this fails, keep the DB record.
    for (const key of [...new Set(keys)]) {
      await deleteB2Object(key);
    }

    await pool.query(
      "DELETE FROM public.games WHERE id = $1",
      [game.id]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Frontend static files
app.use(express.static(path.join(ROOT, "public")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);

  const status =
    err instanceof multer.MulterError ? 400 : 500;

  res.status(status).json({
    error: err instanceof multer.MulterError
      ? err.message
      : "Something went wrong. Check the server logs."
  });
});

app.listen(PORT, () => {
  console.log(`NEON GAMES PostgreSQL + B2 server running on port ${PORT}`);
});
