import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { connection } from "../../connection.js";
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  login,
  signup,
} from "./auth.js";
import { requireAuth, requireUserTypes } from "../middleware/auth.js";

const password = "SafePass123";
const adminKey = "unit-test-admin-key-strong";
let savedUser;
let passwordHash;
let originalQuery;

const createResponse = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

before(async () => {
  passwordHash = await bcrypt.hash(password, 4);
});

beforeEach(() => {
  process.env.JWT_SECRET = "unit-test-jwt-secret-longer-than-32-characters";
  process.env.ADMIN_SIGNUP_KEY = adminKey;
  savedUser = null;
  originalQuery = connection.query;
  connection.query = async (query, values) => {
    if (query.includes("INSERT INTO users")) {
      savedUser = {
        id: 42,
        name: values[0],
        mobile: values[1],
        password_hash: values[2],
        user_type: values[3],
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      };
      return { rows: [savedUser] };
    }

    if (query.includes("FROM users")) {
      return { rows: savedUser ? [savedUser] : [] };
    }

    throw new Error("Unexpected database query in test");
  };
});

afterEach(() => {
  connection.query = originalQuery;
});

test("signup creates user, returns token, and never returns password hash", async () => {
  const response = createResponse();
  await signup(
    {
      body: {
        name: "Test User",
        mobile: "98765 43210",
        password,
        userType: "Salesperson",
      },
    },
    response
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.user.userType, "Salesperson");
  assert.equal(response.body.user.mobile, "9876543210");
  assert.equal("password_hash" in response.body.user, false);
  assert.equal(await bcrypt.compare(password, savedUser.password_hash), true);
  assert.equal(
    jwt.verify(response.body.token, process.env.JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }).sub,
    "42"
  );
});

test("signup denies admin registration with an invalid key", async () => {
  const response = createResponse();
  await signup(
    {
      body: {
        name: "Test Admin",
        mobile: "9876543210",
        password,
        userType: "Admin",
        adminKey: "wrong-key",
      },
    },
    response
  );

  assert.equal(response.statusCode, 403);
  assert.equal(savedUser, null);
});

test("signup permits admin registration with the configured key", async () => {
  const response = createResponse();
  await signup(
    {
      body: {
        name: "Test Admin",
        mobile: "9876543210",
        password,
        userType: "Admin",
        adminKey,
      },
    },
    response
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.user.userType, "Admin");
});

test("login returns token only when password matches", async () => {
  savedUser = {
    id: 42,
    name: "Test User",
    mobile: "9876543210",
    password_hash: passwordHash,
    user_type: "Salesperson",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  const success = createResponse();
  await login(
    { body: { mobile: savedUser.mobile, password } },
    success
  );
  assert.equal(success.statusCode, 200);
  assert.ok(success.body.token);

  const failure = createResponse();
  await login(
    { body: { mobile: savedUser.mobile, password: "wrong-password" } },
    failure
  );
  assert.equal(failure.statusCode, 401);
});

test("authenticated middleware loads user and role middleware denies other roles", async () => {
  savedUser = {
    id: 42,
    name: "Test User",
    mobile: "9876543210",
    password_hash: passwordHash,
    user_type: "Salesperson",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const token = jwt.sign({}, process.env.JWT_SECRET, {
    subject: String(savedUser.id),
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "8h",
  });
  const request = {
    get: () => `Bearer ${token}`,
  };
  const response = createResponse();
  let passedAuthentication = false;

  await requireAuth(request, response, () => {
    passedAuthentication = true;
  });
  assert.equal(passedAuthentication, true);
  assert.equal(request.user.userType, "Salesperson");

  let calledNext = false;
  requireUserTypes("Admin")(request, response, () => {
    calledNext = true;
  });
  assert.equal(response.statusCode, 403);
  assert.equal(calledNext, false);

  let salespersonAllowed = false;
  requireUserTypes("Admin", "Salesperson")(request, response, () => {
    salespersonAllowed = true;
  });
  assert.equal(salespersonAllowed, true);
});
