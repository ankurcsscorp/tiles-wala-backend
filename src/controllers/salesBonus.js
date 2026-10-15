import { connection } from "../../connection.js";
import {
  calculateSalesBonusSummary,
  SalesBonusValidationError,
  validateSalesBonusSummary,
  validateSalesBonusRows,
} from "../utils/salesBonusCalculator.js";

const VALID_USER_TYPES = new Set(["Salesperson", "Tile Mistire"]);
const PRODUCT_COLUMNS = `id, product_name, default_cost_price, default_bonus_percentage, unit_label, is_active`;

const validateProductPayload = (body, requireActive = false) => {
  const productName = typeof body?.product_name === "string"
    ? body.product_name.trim()
    : "";
  const unitLabel = typeof body?.unit_label === "string"
    ? body.unit_label.trim()
    : "";
  const costPrice = body?.default_cost_price === "" ? Number.NaN : Number(body?.default_cost_price);
  const bonusPercentage = body?.default_bonus_percentage === ""
    ? Number.NaN
    : Number(body?.default_bonus_percentage);

  if (!productName || productName.length > 200) {
    return { error: "Product name is required and must be 200 characters or fewer." };
  }
  if (!Number.isFinite(costPrice) || costPrice < 0 || costPrice >= 10_000_000_000) {
    return { error: "Cost price must be a valid non-negative amount." };
  }
  if (!Number.isFinite(bonusPercentage) || bonusPercentage < 0 || bonusPercentage > 100) {
    return { error: "Bonus percentage must be between 0 and 100." };
  }
  if (!unitLabel || unitLabel.length > 40) {
    return { error: "Unit label is required and must be 40 characters or fewer." };
  }
  if (requireActive && typeof body?.is_active !== "boolean") {
    return { error: "Product active status must be true or false." };
  }

  return {
    value: {
      productName,
      costPrice,
      bonusPercentage,
      unitLabel,
      isActive: requireActive ? body.is_active : true,
    },
  };
};

export const getProductCatalog = async (_req, res) => {
  try {
    const productQuery = await connection.query(
      `SELECT id, product_name, default_cost_price, default_bonus_percentage, unit_label
       FROM sales_bonus_product_config
       WHERE is_active = TRUE
       ORDER BY product_name ASC;`
    );

    return res.status(200).json(productQuery.rows);
  } catch (error) {
    console.error("Error fetching sales bonus product catalog:", error.message);
    return res.status(500).json({ message: "Unable to load product catalog" });
  }
};

export const getManageableProductCatalog = async (_req, res) => {
  try {
    const productQuery = await connection.query(
      `SELECT ${PRODUCT_COLUMNS}
       FROM sales_bonus_product_config
       ORDER BY is_active DESC, product_name ASC;`
    );

    return res.status(200).json(productQuery.rows);
  } catch (error) {
    console.error("Error fetching manageable product catalog:", error.message);
    return res.status(500).json({ message: "Unable to load product catalog" });
  }
};

export const createProductConfig = async (req, res) => {
  const validation = validateProductPayload(req.body);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { productName, costPrice, bonusPercentage, unitLabel, isActive } = validation.value;
  try {
    const result = await connection.query(
      `INSERT INTO sales_bonus_product_config (
         product_name, default_cost_price, default_bonus_percentage, unit_label, is_active
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PRODUCT_COLUMNS};`,
      [productName, costPrice, bonusPercentage, unitLabel, isActive]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "A product with that name already exists." });
    }
    console.error("Error creating sales bonus product:", error.message);
    return res.status(500).json({ message: "Unable to create product" });
  }
};

export const updateProductConfig = async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return res.status(400).json({ message: "A valid product ID is required." });
  }

  const validation = validateProductPayload(req.body, true);
  if (validation.error) {
    return res.status(400).json({ message: validation.error });
  }

  const { productName, costPrice, bonusPercentage, unitLabel, isActive } = validation.value;
  try {
    const result = await connection.query(
      `UPDATE sales_bonus_product_config
       SET product_name = $1,
           default_cost_price = $2,
           default_bonus_percentage = $3,
           unit_label = $4,
           is_active = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING ${PRODUCT_COLUMNS};`,
      [productName, costPrice, bonusPercentage, unitLabel, isActive, productId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "Product was not found." });
    }
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "A product with that name already exists." });
    }
    console.error("Error updating sales bonus product:", error.message);
    return res.status(500).json({ message: "Unable to update product" });
  }
};

export const createSalesBonusRecord = async (req, res) => {
  const { selectedUserId, selectedUserType, rows } = req.body ?? {};
  const userId = Number(selectedUserId);

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(400).json({ message: "A valid user ID is required" });
  }

  if (!VALID_USER_TYPES.has(selectedUserType)) {
    return res.status(400).json({ message: "Select a valid user type for bonus allocation" });
  }

  try {
    const userResult = await connection.query(
      `SELECT id, name, mobile, user_type
       FROM users
       WHERE id = $1;`,
      [userId]
    );
    const selectedUser = userResult.rows[0];

    if (!selectedUser) {
      return res.status(404).json({ message: "Selected user was not found" });
    }

    if (selectedUser.user_type !== selectedUserType) {
      return res.status(400).json({
        message: "The selected user does not match the selected user type",
      });
    }

    const catalogResult = await connection.query(
      `SELECT product_name, default_cost_price, default_bonus_percentage
       FROM sales_bonus_product_config
       WHERE is_active = TRUE
       ORDER BY product_name ASC;`
    );
    const preparedRows = validateSalesBonusRows(
      rows,
      selectedUserType,
      catalogResult.rows
    );
    const summary = validateSalesBonusSummary(
      calculateSalesBonusSummary(preparedRows, selectedUserType)
    );

    const rawPaidAmount = req.body?.totalAmountPaid ?? 0;
    const totalAmountPaidInput =
      typeof rawPaidAmount === "string" && rawPaidAmount.trim() === ""
        ? Number.NaN
        : Number(rawPaidAmount);
    const isFullyPaid = req.body?.isFullyPaid ?? false;
    const paymentMethod = req.body?.paymentMethod || null;

    if (typeof isFullyPaid !== "boolean") {
      return res.status(400).json({ message: "Full-paid status must be true or false." });
    }
    if (!Number.isFinite(totalAmountPaidInput) || totalAmountPaidInput < 0) {
      return res.status(400).json({ message: "Paid amount must be a valid non-negative amount." });
    }
    if (paymentMethod !== null && !["UPI", "CASH"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Payment method must be UPI or CASH." });
    }

    const totalAmountPaid = isFullyPaid
      ? summary.finalUserBonus
      : Math.round(totalAmountPaidInput * 100) / 100;
    if (totalAmountPaid > summary.finalUserBonus) {
      return res.status(400).json({ message: "Paid amount cannot exceed the final user bonus payable." });
    }
    if (totalAmountPaid > 0 && !paymentMethod) {
      return res.status(400).json({ message: "Select a payment method for the paid amount." });
    }

    const client = await connection.connect();

    let record;
    try {
      await client.query("BEGIN");

      const recordResult = await client.query(
        `INSERT INTO sales_bonus_records (
          user_id,
          selected_user_type,
          total_quantity,
          total_cost,
          total_selling_amount,
          total_gross_profit,
          total_gross_bonus,
          final_user_bonus,
          total_amount_paid,
          payment_method,
          is_fully_paid,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
        RETURNING *;`,
        [
          userId,
          selectedUserType,
          summary.totalQuantity,
          summary.totalCost,
          summary.totalSellingAmount,
          summary.totalGrossProfit,
          summary.totalGrossBonus,
          summary.finalUserBonus,
          totalAmountPaid,
          totalAmountPaid > 0 ? paymentMethod : null,
          isFullyPaid,
        ]
      );

      record = recordResult.rows[0];

      for (const row of preparedRows) {
        await client.query(
          `INSERT INTO sales_bonus_record_items (
            sales_bonus_record_id,
            product_name,
            cost_price,
            selling_price,
            quantity,
            total_cost,
            total_selling_amount,
            gross_profit,
            bonus_percentage,
            gross_bonus,
            user_bonus
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
          [
            record.id,
            row.productName,
            row.costPrice,
            row.sellingPrice,
            row.quantity,
            row.totalCost,
            row.totalSellingAmount,
            row.grossProfit,
            row.bonusRate,
            row.grossBonus,
            row.userBonus,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Error rolling back sales bonus record:", rollbackError.message);
      }
      throw error;
    } finally {
      client.release();
    }

    return res.status(201).json({
      message: "Sales bonus record created successfully",
      record: {
        ...record,
        selectedUser,
        items: preparedRows,
      },
    });
  } catch (error) {
    if (error instanceof SalesBonusValidationError) {
      return res.status(400).json({ message: error.message });
    }

    console.error("Error creating sales bonus record:", error.message);
    return res.status(500).json({ message: "Unable to create sales bonus record" });
  }
};
