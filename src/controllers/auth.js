import {effectivePermissions} from '../services/permissions.js';
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connection } from "../../connection.js";

export const USER_TYPES = [
  "Admin",
  "Salesperson",
  "Tile Mistire",
  "Plumber Mistiri",
];

export const JWT_ISSUER = "tiles-wala-backend";
export const JWT_AUDIENCE = "tiles-wala-frontend";
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72;
const BCRYPT_ROUNDS = 12;
const MISTIRI_USER_TYPES = new Set(["Tile Mistire", "Plumber Mistiri"]);

export const assertAuthConfiguration = () => {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 characters.");
  }

  if (
    process.env.ADMIN_SIGNUP_KEY &&
    process.env.ADMIN_SIGNUP_KEY.length < 16
  ) {
    throw new Error("ADMIN_SIGNUP_KEY must be at least 16 characters.");
  }
};

const normalizeMobile = (value) => {
  if (typeof value !== "string") return null;

  const mobile = value.trim().replace(/[\s()-]/g, "");
  return /^\+?\d{7,15}$/.test(mobile) ? mobile : null;
};

const normalizeUserType = (value) => {
  if (typeof value !== "string") return null;
  return USER_TYPES.find(
    (userType) => userType.toLowerCase() === value.trim().toLowerCase()
  ) ?? null;
};

const toPublicUser = (row) => ({
  id: row.id,
  name: row.name,
  mobile: row.mobile,
  userType: row.user_type,
  areaLocation: row.area_location ?? null,
  createdAt: row.created_at,
  permissions: effectivePermissions(row.user_type,row.role_permissions,row.permission_overrides),
});

const createToken = (user) =>
  jwt.sign({}, process.env.JWT_SECRET, {
    subject: String(user.id),
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "8h",
  });

const sendAuthenticatedResponse = (res, row, statusCode = 200) => {
  const user = toPublicUser(row);
  return res.status(statusCode).json({
    message:
      statusCode === 201
        ? "Account created successfully"
        : "Signed in successfully",
    user,
    token: createToken(user),
  });
};

const matchesAdminSignupKey = (providedKey, configuredKey) => {
  if (typeof providedKey !== "string" || !configuredKey) return false;

  const providedDigest = createHash("sha256").update(providedKey).digest();
  const configuredDigest = createHash("sha256").update(configuredKey).digest();
  return timingSafeEqual(providedDigest, configuredDigest);
};

export const signup = async (req, res) => {
  const {
    name,
    mobile: rawMobile,
    password,
    userType: rawUserType,
    areaLocation: rawAreaLocation,
  } = req.body ?? {};
  const mobile = normalizeMobile(rawMobile);
  const userType = normalizeUserType(rawUserType);
  const areaLocation =
    typeof rawAreaLocation === "string" ? rawAreaLocation.trim() : "";

  if (typeof name !== "string" || !name.trim() || name.trim().length > 150) {
    return res.status(400).json({
      message: "Name is required and must be 150 characters or fewer",
    });
  }

  if (!mobile) {
    return res.status(400).json({
      message: "Enter a valid mobile number with 7 to 15 digits",
    });
  }

  if (
    typeof password !== "string" ||
    password.length < PASSWORD_MIN_LENGTH ||
    Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES
  ) {
    return res.status(400).json({
      message: "Password must be at least 8 characters and no more than 72 bytes",
    });
  }

  if (!userType) {
    return res.status(400).json({ message: "Select a valid user type" });
  }

  if (
    MISTIRI_USER_TYPES.has(userType) &&
    (!areaLocation || areaLocation.length > 200)
  ) {
    return res.status(400).json({
      message: "Area/Location is required and must be 200 characters or fewer",
    });
  }

  if (areaLocation.length > 200) {
    return res.status(400).json({
      message: "Area/Location must be 200 characters or fewer",
    });
  }

  if (userType === "Admin") {
    if (!process.env.ADMIN_SIGNUP_KEY) {
      return res.status(503).json({
        message: "Admin signup is not configured",
      });
    }
    if (!matchesAdminSignupKey(req.body.adminKey, process.env.ADMIN_SIGNUP_KEY)) {
      return res.status(403).json({ message: "Invalid admin signup key" });
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await connection.query(
      `INSERT INTO users (name, mobile, password_hash, user_type, area_location)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, mobile, user_type, area_location, created_at,is_active,permission_overrides,(SELECT permissions FROM role_permission_settings WHERE user_type=users.user_type) AS role_permissions`,
      [
        name.trim(),
        mobile,
        passwordHash,
        userType,
        MISTIRI_USER_TYPES.has(userType) ? areaLocation : null,
      ]
    );

    return sendAuthenticatedResponse(res, result.rows[0], 201);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "An account with this mobile number already exists",
      });
    }

    console.error("Error creating user account:", error.message);
    return res.status(500).json({ message: "Unable to create account" });
  }
};

const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  randomBytes(32).toString("hex"),
  BCRYPT_ROUNDS
);

export const login = async (req, res) => {
  const { mobile: rawMobile, password } = req.body ?? {};
  const mobile = normalizeMobile(rawMobile);

  if (
    !mobile ||
    typeof password !== "string" ||
    !password ||
    Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES
  ) {
    return res.status(400).json({
      message: "Enter a valid mobile number and password",
    });
  }

  try {
    const result = await connection.query(
      `SELECT id, name, mobile, user_type, area_location, password_hash, created_at,is_active,permission_overrides,(SELECT permissions FROM role_permission_settings WHERE user_type=users.user_type) AS role_permissions
       FROM users
       WHERE mobile = $1`,
      [mobile]
    );
    const row = result.rows[0];
    const passwordMatches = await bcrypt.compare(
      password,
      row?.password_hash ?? DUMMY_PASSWORD_HASH
    );

    if (!row || !passwordMatches || row.is_active===false) {
      return res.status(401).json({ message: "Invalid mobile number or password" });
    }

    return sendAuthenticatedResponse(res, row);
  } catch (error) {
    console.error("Error signing in:", error.message);
    return res.status(500).json({ message: "Unable to sign in" });
  }
};