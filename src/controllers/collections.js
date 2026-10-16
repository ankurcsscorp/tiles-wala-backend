import { connection } from "../../connection.js";

const MAX_IMAGES = 5;
const MAX_TOTAL_IMAGE_DATA_LENGTH = 11_200_000;
const IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const LOCAL_IMAGE_PATH_PATTERN = /^\/images\/(?!.*\.\.)[A-Za-z0-9._-]+$/;

const validateCollection = (body) => {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const size = typeof body?.size === "string" ? body.size.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : "";
  const images = body?.images;

  if (!name || name.length > 150) {
    return { error: "Collection name is required and must be 150 characters or fewer." };
  }
  if (!size || size.length > 80) {
    return { error: "Tile size is required and must be 80 characters or fewer." };
  }
  if (!description || description.length > 1000) {
    return { error: "Description is required and must be 1000 characters or fewer." };
  }
  if (
    !Array.isArray(images) ||
    images.length < 1 ||
    images.length > MAX_IMAGES ||
    images.some(
      (image) =>
        typeof image !== "string" ||
        (!IMAGE_DATA_URL_PATTERN.test(image) &&
          !LOCAL_IMAGE_PATH_PATTERN.test(image))
    )
  ) {
    return {
      error: `Add between 1 and ${MAX_IMAGES} valid JPG, PNG, or WebP tile pictures.`,
    };
  }
  if (
    images.reduce((total, image) => total + image.length, 0) >
    MAX_TOTAL_IMAGE_DATA_LENGTH
  ) {
    return { error: "The combined size of your pictures must be 8 MB or less." };
  }

  return { value: { name, size, description, images } };
};

export const getCollections = async (_req, res) => {
  try {
    const result = await connection.query(
      `SELECT id, featured_key, name, size, description, images, created_at
       FROM tile_collections
       ORDER BY created_at DESC, id DESC`
    );
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching tile collections:", error.message);
    return res.status(500).json({ message: "Unable to load tile collections." });
  }
};

export const updateCollection = async (req, res) => {
  const collectionId = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(collectionId) || collectionId < 1) {
    return res.status(400).json({ message: "A valid collection ID is required." });
  }

  const validation = validateCollection(req.body);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { name, size, description, images } = validation.value;
  try {
    const result = await connection.query(
      `UPDATE tile_collections
       SET name = $1, size = $2, description = $3, images = $4
       WHERE id = $5 AND featured_key IS NULL
       RETURNING id, featured_key, name, size, description, images, created_at`,
      [name, size, description, JSON.stringify(images), collectionId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ message: "Tile collection was not found." });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating tile collection:", error.message);
    return res.status(500).json({ message: "Unable to update tile collection." });
  }
};

export const updateFeaturedCollection = async (req, res) => {
  const featuredKey = req.params.featuredId;
  if (!/^\d+$/.test(featuredKey) || Number(featuredKey) < 1 || Number(featuredKey) > 12) {
    return res.status(400).json({ message: "A valid featured collection ID is required." });
  }

  const validation = validateCollection(req.body);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { name, size, description, images } = validation.value;
  try {
    const result = await connection.query(
      `INSERT INTO tile_collections (featured_key, name, size, description, images)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (featured_key) WHERE featured_key IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name,
                     size = EXCLUDED.size,
                     description = EXCLUDED.description,
                     images = EXCLUDED.images
       RETURNING id, featured_key, name, size, description, images, created_at`,
      [featuredKey, name, size, description, JSON.stringify(images)]
    );
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Error updating featured tile collection:", error.message);
    return res.status(500).json({ message: "Unable to update tile collection." });
  }
};

export const createCollection = async (req, res) => {
  const validation = validateCollection(req.body);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { name, size, description, images } = validation.value;
  try {
    const result = await connection.query(
      `INSERT INTO tile_collections (name, size, description, images)
       VALUES ($1, $2, $3, $4)
       RETURNING id, featured_key, name, size, description, images, created_at`,
      [name, size, description, JSON.stringify(images)]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating tile collection:", error.message);
    return res.status(500).json({ message: "Unable to save tile collection." });
  }
};
