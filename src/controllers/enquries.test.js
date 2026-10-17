import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import { updateEnquiry } from "./enquries.js";

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

afterEach(() => {
  if (originalQuery) {
    connection.query = originalQuery;
    originalQuery = null;
  }
});

test("updating an enquiry refreshes updated_at without changing created_at", () => {
  let executedQuery;
  let queryValues;
  const enquiry = {
    id: 7,
    remark: "Follow up",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-02T00:00:00.000Z"),
  };
  originalQuery = connection.query;
  connection.query = (query, values, callback) => {
    executedQuery = query;
    queryValues = values;
    callback(null, { rows: [enquiry], rowCount: 1 });
  };

  const response = createResponse();
  updateEnquiry(
    { params: { id: "7" }, body: { remark: "Follow up" } },
    response
  );

  assert.match(executedQuery, /updated_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(executedQuery, /created_at\s*=/);
  assert.deepEqual(queryValues, ["Follow up", 7]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.enquiry.created_at, enquiry.created_at);
  assert.equal(response.body.enquiry.updated_at, enquiry.updated_at);
});
