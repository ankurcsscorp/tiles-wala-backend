import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connection } from "../../connection.js";
import {
  createCollection,
  getCollections,
  updateCollection,
  updateFeaturedCollection,
} from "./collections.js";

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

test("creates a collection with trimmed details and image gallery", async () => {
  let queryValues;
  const savedCollection = {
    id: "3",
    name: "Calacatta Gold",
    size: "600 x 1200 mm",
    description: "Polished marble look.",
    images: ["data:image/png;base64,aGVsbG8="],
  };
  originalQuery = connection.query;
  connection.query = async (_query, values) => {
    queryValues = values;
    return { rows: [savedCollection] };
  };

  const response = createResponse();
  await createCollection(
    {
      body: {
        name: " Calacatta Gold ",
        size: " 600 x 1200 mm ",
        description: " Polished marble look. ",
        images: ["data:image/png;base64,aGVsbG8="],
      },
    },
    response
  );

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.name, "Calacatta Gold");
  assert.deepEqual(JSON.parse(queryValues[3]), savedCollection.images);
});

test("rejects invalid collection images before saving", async () => {
  originalQuery = connection.query;
  connection.query = async () => {
    throw new Error("Database should not be queried for invalid input");
  };

  const response = createResponse();
  await createCollection(
    {
      body: {
        name: "Calacatta Gold",
        size: "600 x 1200 mm",
        description: "Polished marble look.",
        images: ["https://example.com/tile.png"],
      },
    },
    response
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /valid JPG, PNG, or WebP/);
});

test("returns all saved collections for the public gallery", async () => {
  const savedCollections = [{ id: "3", featured_key: null, name: "Calacatta Gold" }];
  originalQuery = connection.query;
  connection.query = async () => ({ rows: savedCollections });

  const response = createResponse();
  await getCollections({}, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, savedCollections);
});

test("updates a saved collection and rejects unknown IDs", async () => {
  const updatedCollection = {
    id: "3",
    featured_key: null,
    name: "Calacatta Gold Updated",
  };
  originalQuery = connection.query;
  connection.query = async (_query, values) => {
    assert.deepEqual(values, [
      "Calacatta Gold Updated",
      "600 x 1200 mm",
      "Polished marble look.",
      JSON.stringify(["/images/1.3.jpg"]),
      3,
    ]);
    return { rows: [updatedCollection] };
  };

  const response = createResponse();
  await updateCollection(
    {
      params: { id: "3" },
      body: {
        name: "Calacatta Gold Updated",
        size: "600 x 1200 mm",
        description: "Polished marble look.",
        images: ["/images/1.3.jpg"],
      },
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, updatedCollection);

  connection.query = async () => ({ rows: [] });
  const missingResponse = createResponse();
  await updateCollection(
    {
      params: { id: "999" },
      body: {
        name: "Calacatta Gold Updated",
        size: "600 x 1200 mm",
        description: "Polished marble look.",
        images: ["/images/1.3.jpg"],
      },
    },
    missingResponse
  );
  assert.equal(missingResponse.statusCode, 404);
});

test("upserts edits to featured products", async () => {
  const updatedCollection = {
    id: "12",
    featured_key: "1",
    name: "Marvilla Blue Updated",
  };
  originalQuery = connection.query;
  connection.query = async (query, values) => {
    assert.match(query, /ON CONFLICT \(featured_key\)/);
    assert.equal(values[0], "1");
    return { rows: [updatedCollection] };
  };

  const response = createResponse();
  await updateFeaturedCollection(
    {
      params: { featuredId: "1" },
      body: {
        name: "Marvilla Blue Updated",
        size: "600x1200",
        description: "Book Match Glossy",
        images: ["/images/1.3.jpg"],
      },
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, updatedCollection);
});
