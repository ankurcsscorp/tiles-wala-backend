import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { connection } from "../../connection.js";
import {
  createProductConfig,
  createSalesBonusRecord,
  getManageableProductCatalog,
  updateProductConfig,
} from "./salesBonus.js";

const configuredProduct = {
  product_name: "Configured Tile",
  default_cost_price: "100.00",
  default_bonus_percentage: "5.00",
};

let originalQuery;
let originalConnect;
let selectedUser;
let insertedRecord;
let insertedItemValues;
let transactionCommands;
let connectCount;
let failItemInsert;
let releaseCount;

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

beforeEach(() => {
  selectedUser = {
    id: 12,
    name: "Tile Partner",
    mobile: "9876543210",
    user_type: "Salesperson",
  };
  insertedRecord = null;
  insertedItemValues = [];
  transactionCommands = [];
  connectCount = 0;
  failItemInsert = false;
  releaseCount = 0;
  originalQuery = connection.query;
  originalConnect = connection.connect;

  connection.query = async (query) => {
    if (query.includes("FROM users")) {
      return { rows: selectedUser ? [selectedUser] : [] };
    }
    if (query.includes("FROM sales_bonus_product_config")) {
      return { rows: [configuredProduct] };
    }
    throw new Error(`Unexpected pool query: ${query}`);
  };
  connection.connect = async () => {
    connectCount += 1;
    return {
      query: async (query, values) => {
        transactionCommands.push(query.trim());
        if (query.includes("INSERT INTO sales_bonus_records")) {
          insertedRecord = {
            id: 55,
            user_id: values[0],
            selected_user_type: values[1],
            total_quantity: values[2],
            total_cost: values[3],
            total_selling_amount: values[4],
            total_gross_profit: values[5],
            total_gross_bonus: values[6],
            final_user_bonus: values[7],
            total_amount_paid: values[8],
            payment_method: values[9],
            is_fully_paid: values[10],
          };
          return { rows: [insertedRecord] };
        }
        if (query.includes("INSERT INTO sales_bonus_record_items")) {
          if (failItemInsert) {
            throw new Error("Simulated item insert failure");
          }
          insertedItemValues = values;
        }
        return { rows: [] };
      },
      release() {
        releaseCount += 1;
      },
    };
  };
});

afterEach(() => {
  connection.query = originalQuery;
  connection.connect = originalConnect;
});

test("creates a record using configured cost and calculates the salesperson allocation", async () => {
  const response = createResponse();
  await createSalesBonusRecord(
    {
      body: {
        selectedUserId: 12,
        selectedUserType: "Salesperson",
        rows: [
          {
            productName: "Configured Tile",
            costPrice: 1,
            sellingPrice: 130,
            quantity: 2,
            bonusRate: 10,
          },
        ],
      },
    },
    response
  );

  assert.equal(response.statusCode, 201);
  assert.equal(insertedRecord.total_cost, 200);
  assert.equal(insertedRecord.total_selling_amount, 260);
  assert.equal(insertedRecord.total_gross_profit, 60);
  assert.equal(insertedRecord.total_gross_bonus, 6);
  assert.equal(insertedRecord.final_user_bonus, 3);
  assert.equal(insertedRecord.total_amount_paid, 0);
  assert.equal(insertedRecord.payment_method, null);
  assert.equal(insertedRecord.is_fully_paid, false);
  assert.equal(insertedItemValues[2], 100);
  assert.equal(insertedItemValues[10], 3);
  assert.equal(response.body.record.selectedUser.id, 12);
  assert.equal(transactionCommands.at(-1), "COMMIT");
});

test("marks a record fully paid using the calculated final payable", async () => {
  const response = createResponse();
  await createSalesBonusRecord(
    {
      body: {
        selectedUserId: 12,
        selectedUserType: "Salesperson",
        totalAmountPaid: 0,
        paymentMethod: "UPI",
        isFullyPaid: true,
        rows: [
          {
            productName: "Configured Tile",
            sellingPrice: 130,
            quantity: 2,
            bonusRate: 10,
          },
        ],
      },
    },
    response
  );

  assert.equal(response.statusCode, 201);
  assert.equal(insertedRecord.final_user_bonus, 3);
  assert.equal(insertedRecord.total_amount_paid, 3);
  assert.equal(insertedRecord.payment_method, "UPI");
  assert.equal(insertedRecord.is_fully_paid, true);
});

test("rejects paid amounts above the final payable", async () => {
  const response = createResponse();
  await createSalesBonusRecord(
    {
      body: {
        selectedUserId: 12,
        selectedUserType: "Salesperson",
        totalAmountPaid: 3.01,
        paymentMethod: "CASH",
        rows: [
          {
            productName: "Configured Tile",
            sellingPrice: 130,
            quantity: 2,
            bonusRate: 10,
          },
        ],
      },
    },
    response
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /cannot exceed/);
  assert.equal(connectCount, 0);
});

test("lists active and inactive products for management", async () => {
  const rows = [
    { id: 3, product_name: "Managed Tile", is_active: true },
    { id: 4, product_name: "Retired Tile", is_active: false },
  ];
  connection.query = async (query) => {
    assert.match(query, /ORDER BY is_active DESC, product_name ASC/);
    return { rows };
  };
  const response = createResponse();

  await getManageableProductCatalog({}, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, rows);
});

test("creates a product configuration with validated values", async () => {
  let insertedValues;
  connection.query = async (query, values) => {
    assert.match(query, /INSERT INTO sales_bonus_product_config/);
    insertedValues = values;
    return { rows: [{ id: 18, product_name: values[0], is_active: values[4] }] };
  };
  const response = createResponse();

  await createProductConfig(
    {
      body: {
        product_name: "New Tile",
        default_cost_price: "325.50",
        default_bonus_percentage: "8",
        unit_label: "Box",
      },
    },
    response
  );

  assert.equal(response.statusCode, 201);
  assert.deepEqual(insertedValues, ["New Tile", 325.5, 8, "Box", true]);
});

test("updates product details and active status", async () => {
  let updatedValues;
  connection.query = async (query, values) => {
    assert.match(query, /UPDATE sales_bonus_product_config/);
    updatedValues = values;
    return { rows: [{ id: 18, product_name: values[0], is_active: values[4] }] };
  };
  const response = createResponse();

  await updateProductConfig(
    {
      params: { id: "18" },
      body: {
        product_name: "Updated Tile",
        default_cost_price: 400,
        default_bonus_percentage: 6.5,
        unit_label: "Piece",
        is_active: false,
      },
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(updatedValues, ["Updated Tile", 400, 6.5, "Piece", false, 18]);
});

test("rejects invalid product configuration before querying the database", async () => {
  connection.query = async () => {
    throw new Error("Database should not be queried for invalid input");
  };
  const response = createResponse();

  await createProductConfig(
    {
      body: {
        product_name: "Invalid Tile",
        default_cost_price: -1,
        default_bonus_percentage: 10,
        unit_label: "Box",
      },
    },
    response
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /Cost price/);
});

test("rejects a user type that does not match the selected user", async () => {
  const response = createResponse();
  await createSalesBonusRecord(
    {
      body: {
        selectedUserId: 12,
        selectedUserType: "Tile Mistire",
        rows: [{ productName: "Configured Tile", sellingPrice: 130, quantity: 2 }],
      },
    },
    response
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /does not match/);
  assert.equal(connectCount, 0);
});

test("rejects inactive or unknown products without opening a transaction", async () => {
  const response = createResponse();
  await createSalesBonusRecord(
    {
      body: {
        selectedUserId: 12,
        selectedUserType: "Salesperson",
        rows: [{ productName: "Unknown Tile", sellingPrice: 130, quantity: 2 }],
      },
    },
    response
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /not available in the active catalog/);
  assert.equal(connectCount, 0);
});

test("rejects malformed selling prices and over-limit bonus rates", async (t) => {
  for (const invalidRow of [
    { productName: "Configured Tile", sellingPrice: "130xyz", quantity: 2 },
    {
      productName: "Configured Tile",
      sellingPrice: 130,
      quantity: 2,
      bonusRate: 101,
    },
  ]) {
    await t.test(JSON.stringify(invalidRow), async () => {
      const response = createResponse();
      await createSalesBonusRecord(
        {
          body: {
            selectedUserId: 12,
            selectedUserType: "Salesperson",
            rows: [invalidRow],
          },
        },
        response
      );

      assert.equal(response.statusCode, 400);
      assert.match(response.body.message, /invalid product entry/);
      assert.equal(connectCount, 0);
    });
  }
});

test("rolls back and releases the client if an item insert fails", async () => {
  failItemInsert = true;
  const response = createResponse();

  await createSalesBonusRecord(
    {
      body: {
        selectedUserId: 12,
        selectedUserType: "Salesperson",
        rows: [
          {
            productName: "Configured Tile",
            sellingPrice: 130,
            quantity: 2,
          },
        ],
      },
    },
    response
  );

  assert.equal(response.statusCode, 500);
  assert.equal(transactionCommands.at(-1), "ROLLBACK");
  assert.equal(releaseCount, 1);
});
