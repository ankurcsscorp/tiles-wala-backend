import {effectivePermissions} from '../services/permissions.js';
import jwt from "jsonwebtoken";
import { connection } from "../../connection.js";
import { JWT_AUDIENCE, JWT_ISSUER } from "../controllers/auth.js";

export const requireAuth = async (req, res, next) => {
  const authorization = req.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ message: "Authentication is required" });
  }

  let payload;
  try {
    payload = jwt.verify(match[1], process.env.JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch {
    return res.status(401).json({
      message: "Authentication token is invalid or expired",
    });
  }

  if (typeof payload === "string" || !/^\d+$/.test(payload.sub ?? "")) {
    return res.status(401).json({
      message: "Authentication token is invalid or expired",
    });
  }

  try {
    const result = await connection.query(
      `SELECT id, name, mobile, user_type,is_active,permission_overrides,(SELECT permissions FROM role_permission_settings WHERE user_type=users.user_type) AS role_permissions
       FROM users
       WHERE id = $1`,
      [payload.sub]
    );
    const user = result.rows[0];

    if (!user || user.is_active===false) {
      return res.status(401).json({
        message: "Authentication token is invalid or expired",
      });
    }

    req.user = {
      id: user.id,
      name: user.name,
      mobile: user.mobile,
      userType: user.user_type,
      permissions:effectivePermissions(user.user_type,user.role_permissions,user.permission_overrides),
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireUserTypes = (...userTypes) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication is required" });
  }

  const allowedTypes = userTypes.map((userType) => userType.toLowerCase());
  if (!allowedTypes.includes(req.user.userType.toLowerCase())) {
    return res.status(403).json({
      message: "You do not have permission for this action",
    });
  }

  return next();
};
