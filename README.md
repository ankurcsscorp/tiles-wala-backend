# tiles-wala-backend

Backend for the Tiles Wala application.

## Local setup

1. Create a PostgreSQL database (the default configured name is `tilesWala`).
2. Copy `.env.example` to `.env` and set the PostgreSQL username and password.
3. Set `JWT_SECRET` to a cryptographically random value of at least 32 characters.
   For example, generate one with `openssl rand -base64 48`.
4. Set `ADMIN_SIGNUP_KEY` to a separate random value of at least 16 characters.
   It is required to register an Admin; other user types can sign up without it.
5. Run `npm install`, then `npm start` (or `npm run dev` for reload-on-change).

At startup, the backend creates the `users` table if it does not exist. Passwords
are stored as bcrypt hashes. Keep `.env` private and do not commit it.

## Authentication API

- `POST /api/tiles/auth/signup` accepts `{ name, mobile, password, userType }`.
  Admin signup must also include `{ adminKey }`.
- `POST /api/tiles/auth/login` accepts `{ mobile, password }`.
- Both endpoints return `{ message, user, token }`; `user` includes `id`, `name`,
  `mobile`, `userType`, and `createdAt`. The bearer token expires after 8 hours.
- Mobile numbers are unique. Passwords must be at least 8 characters and no
  more than 72 UTF-8 bytes.

Use the token as `Authorization: Bearer <token>` for protected API requests.
Only Admin and Salesperson users may list and update enquiries. Creating an
enquiry remains public for the customer enquiry form. The frontend restricts
management pages by role, but backend middleware is authoritative.

User types accepted at signup: `Admin`, `Salesperson`, `Tile Mistire`, and
`Plumber Mistiri`.

Run backend unit tests with `npm test`.
