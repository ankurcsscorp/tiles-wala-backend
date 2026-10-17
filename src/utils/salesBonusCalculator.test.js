import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateSalesBonusRow,
  calculateSalesBonusSummary,
  validateSalesBonusRows,
} from "./salesBonusCalculator.js";

const catalog = [
  {
    product_name: "Configured Tile",
    default_cost_price: "100.00",
    default_bonus_percentage: "5.00",
  },
];

test("calculates no gross bonus when selling price is below cost", () => {
  const result = calculateSalesBonusRow({
    costPrice: 100,
    sellingPrice: 90,
    quantity: 2,
    bonusRate: 10,
    userType: "Tile Mistire",
  });

  assert.equal(result.grossProfit, -20);
  assert.equal(result.grossBonus, 0);
  assert.equal(result.userBonus, 0);
});

test("rounds calculated bonus and aggregated totals to cents", () => {
  const rows = [
    {
      costPrice: 10,
      sellingPrice: 10.05,
      quantity: 1,
      bonusRate: 10,
    },
    {
      costPrice: 10,
      sellingPrice: 10.05,
      quantity: 1,
      bonusRate: 10,
    },
  ];

  assert.deepEqual(calculateSalesBonusSummary(rows, "Tile Mistire"), {
    totalQuantity: 2,
    totalCost: 20,
    totalSellingAmount: 20.1,
    totalGrossProfit: 0.1,
    totalGrossBonus: 0.02,
    finalUserBonus: 0.02,
  });
});

test("takes cost from product configuration rather than the submitted price", () => {
  const [row] = validateSalesBonusRows(
    [
      {
        productName: "Configured Tile",
        costPrice: 1,
        sellingPrice: 130,
        quantity: 2,
      },
    ],
    "Tile Mistire",
    catalog
  );

  assert.equal(row.costPrice, 100);
  assert.equal(row.bonusRate, 5);
  assert.equal(row.totalCost, 200);
  assert.equal(row.userBonus, 3);
});
